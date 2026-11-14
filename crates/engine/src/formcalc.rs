//! M3 : calculs, validations et contrôle de saisie des formulaires.
//!
//! Les formulaires portent des scripts JavaScript (actions /AA : calcul /C, validation /V,
//! frappe /K). PDFium sans V8 ne les exécute pas. Ici :
//! - les fonctions standard d'Acrobat (AFSimple_Calculate, notation simplifiée « BVCALC »,
//!   AFRange_Validate, AFNumber_Keystroke) sont reconnues et calculées en Rust, sans exécuter
//!   le code du document ;
//! - tout autre script tourne dans QuickJS, isolé : ni fichier, ni réseau, ni accès à
//!   l'application ; seulement les valeurs des champs (getField), l'objet `event` et quelques
//!   fonctions AF ; mémoire et durée limitées.

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use pdfium_render::prelude::*;

use crate::fill::{FIELD_COMBOBOX, FIELD_TEXTFIELD, FieldInput, FormPage, WIDGET, get_annot, read_wide};

// Événements des actions supplémentaires (fpdf_annot.h).
const AA_KEYSTROKE: i32 = 12;
const AA_VALIDATE: i32 = 14;
const AA_CALCULATE: i32 = 15;

/// Limites contre les PDF piégés.
const MAX_FIELDS: usize = 5000;
const MAX_PAGES: i32 = 2000;
const MAX_SCRIPT_LEN: usize = 64 * 1024;
const JS_TIME: Duration = Duration::from_millis(150);
const JS_MEMORY: usize = 16 * 1024 * 1024;
const MAX_PASSES: usize = 10;

/// Un champ et ses scripts (premier widget rencontré pour chaque nom).
#[derive(Debug, Clone)]
pub struct ScriptedField {
    pub name: String,
    pub page: i32,
    pub index: i32,
    pub text: bool,
    pub value: String,
    pub calculate: String,
    pub validate: String,
    pub keystroke: String,
}

/// Ce qu'a produit une saisie : pages dont des champs ont changé par calcul, refus éventuel.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed_pages: Vec<i32>,
    /// Saisie refusée par la validation du champ (message à afficher), valeur rétablie.
    pub rejected: Option<String>,
    /// Messages du document (app.alert) pendant les scripts.
    pub alerts: Vec<String>,
    /// Scripts en échec (erreur, délai dépassé) : ignorés.
    pub script_errors: usize,
}

/* ------------------------------------------------------------------ lecture des scripts */

fn script(b: &dyn PdfiumLibraryBindings, form: FPDF_FORMHANDLE, annot: FPDF_ANNOTATION, event: i32) -> String {
    let s = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormAdditionalActionJavaScript(form, annot, event, buf, len as _) as u64 });
    if s.len() > MAX_SCRIPT_LEN { String::new() } else { s }
}

/// Tous les champs du document avec leurs scripts.
pub fn collect(doc: &PdfDocument) -> Vec<ScriptedField> {
    let mut out: Vec<ScriptedField> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let pages = doc.pages().len().min(MAX_PAGES);
    for p in 0..pages {
        let Ok(page) = doc.pages().get(p) else { continue };
        let Some(fp) = FormPage::new(doc, &page) else { return out };
        let b = fp.b;
        let n = unsafe { b.FPDFPage_GetAnnotCount(fp.page) };
        for i in 0..n.min(5000) {
            let Some(a) = get_annot(b, fp.page, i) else { continue };
            if unsafe { b.FPDFAnnot_GetSubtype(a.h) } as i32 != WIDGET {
                continue;
            }
            let name = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldName(fp.form, a.h, buf, len as _) as u64 });
            if name.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            let t = unsafe { b.FPDFAnnot_GetFormFieldType(fp.form, a.h) };
            let value = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldValue(fp.form, a.h, buf, len as _) as u64 });
            out.push(ScriptedField {
                name,
                page: p,
                index: i,
                text: t == FIELD_TEXTFIELD || t == FIELD_COMBOBOX,
                value,
                calculate: script(b, fp.form, a.h, AA_CALCULATE),
                validate: script(b, fp.form, a.h, AA_VALIDATE),
                keystroke: script(b, fp.form, a.h, AA_KEYSTROKE),
            });
            if out.len() >= MAX_FIELDS {
                return out;
            }
        }
    }
    out
}

/// Le document a-t-il des scripts de formulaire (calcul, validation ou frappe) ?
pub fn has_scripts(fields: &[ScriptedField]) -> bool {
    fields.iter().any(|f| !f.calculate.trim().is_empty() || !f.validate.trim().is_empty() || !f.keystroke.trim().is_empty())
}

/* ------------------------------------------------------------------ nombres (AFMakeNumber) */

/// Nombre d'une saisie : espaces ignorés, virgule décimale acceptée. Vide ou non numérique : None.
pub fn make_number(s: &str) -> Option<f64> {
    let t: String = s.chars().filter(|c| !c.is_whitespace() && *c != '\u{a0}' && *c != '\u{202f}').collect();
    if t.is_empty() {
        return None;
    }
    let t = if t.contains(',') && !t.contains('.') { t.replace(',', ".") } else { t.replace(',', "") };
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Nombre écrit comme JavaScript le ferait, sans le bruit des flottants (0,1 + 0,2).
pub fn format_number(v: f64) -> String {
    if !v.is_finite() {
        return String::new();
    }
    let r = (v * 1e10).round() / 1e10;
    let s = format!("{r:.10}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" { "0".into() } else { s }
}

/* ------------------------------------------------------------------ calculs standard */

#[derive(Debug, Clone, PartialEq)]
enum Calc {
    /// AFSimple_Calculate("SUM", new Array("a", "b")).
    Aggregate { op: String, fields: Vec<String> },
    /// Notation simplifiée (commentaire /** BVCALC … EVCALC **/).
    Expr(String),
    Js(String),
    None,
}

fn string_literals(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let mut lit = String::new();
            while let Some(d) = chars.next() {
                if d == '\\' {
                    if let Some(e) = chars.next() {
                        lit.push(e);
                    }
                } else if d == c {
                    break;
                } else {
                    lit.push(d);
                }
            }
            out.push(lit);
        }
    }
    out
}

fn parse_calc(src: &str) -> Calc {
    let s = src.trim();
    if s.is_empty() {
        return Calc::None;
    }
    if let Some(start) = s.find("BVCALC") {
        if let Some(end) = s[start..].find("EVCALC") {
            return Calc::Expr(s[start + 6..start + end].trim().to_string());
        }
    }
    // Un seul appel, rien d'autre : sinon on laisse QuickJS l'exécuter tel quel.
    if let Some(rest) = s.strip_prefix("AFSimple_Calculate") {
        let rest = rest.trim().trim_end_matches(';').trim();
        if rest.starts_with('(') && rest.ends_with(')') && !rest.contains("function") {
            let lits = string_literals(rest);
            if let Some((op, fields)) = lits.split_first() {
                let op = op.to_uppercase();
                if ["SUM", "PRD", "AVG", "MIN", "MAX"].contains(&op.as_str()) {
                    // Liste écrite en une chaîne : « a, b, c ».
                    let fields: Vec<String> = if fields.len() == 1 && fields[0].contains(',') {
                        fields[0].split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
                    } else {
                        fields.to_vec()
                    };
                    return Calc::Aggregate { op, fields };
                }
            }
        }
    }
    Calc::Js(s.to_string())
}

fn aggregate(op: &str, nums: &[f64]) -> f64 {
    match op {
        "SUM" => nums.iter().sum(),
        "PRD" => nums.iter().product(),
        "AVG" => {
            if nums.is_empty() { 0.0 } else { nums.iter().sum::<f64>() / nums.len() as f64 }
        }
        "MIN" => nums.iter().cloned().fold(f64::INFINITY, f64::min),
        _ => nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
    }
}

/// Valeurs des champs nommés (préfixe « a. » : tous les champs « a.x », comme Acrobat).
fn values_of(names: &[String], values: &HashMap<String, String>) -> Vec<f64> {
    let mut out = Vec::new();
    for n in names {
        if let Some(v) = values.get(n) {
            out.push(make_number(v).unwrap_or(0.0));
        } else {
            let prefix = format!("{n}.");
            for (k, v) in values {
                if k.starts_with(&prefix) {
                    out.push(make_number(v).unwrap_or(0.0));
                }
            }
        }
    }
    out
}

/// Expression en notation simplifiée : nombres, noms de champs (« \ » échappe un caractère),
/// + - * / et parenthèses. Champ vide ou inconnu : 0.
pub fn eval_sfn(expr: &str, values: &HashMap<String, String>) -> Option<f64> {
    #[derive(Debug, Clone)]
    enum Tok {
        Num(f64),
        Name(String),
        Op(char),
    }
    let mut toks = Vec::new();
    let cs: Vec<char> = expr.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
        } else if "+-*/()".contains(c) {
            toks.push(Tok::Op(c));
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let st = i;
            while i < cs.len() && (cs[i].is_ascii_digit() || cs[i] == '.') {
                i += 1;
            }
            toks.push(Tok::Num(cs[st..i].iter().collect::<String>().parse().ok()?));
        } else {
            let mut name = String::new();
            while i < cs.len() && !(cs[i].is_whitespace() || "+-*/()".contains(cs[i])) {
                if cs[i] == '\\' && i + 1 < cs.len() {
                    name.push(cs[i + 1]);
                    i += 2;
                } else {
                    name.push(cs[i]);
                    i += 1;
                }
            }
            toks.push(Tok::Name(name));
        }
        if toks.len() > 2000 {
            return None;
        }
    }
    struct P<'a> {
        t: &'a [Tok],
        i: usize,
        v: &'a HashMap<String, String>,
        depth: usize,
    }
    impl P<'_> {
        fn expr(&mut self) -> Option<f64> {
            let mut x = self.term()?;
            while let Some(Tok::Op(c @ ('+' | '-'))) = self.t.get(self.i) {
                let c = *c;
                self.i += 1;
                let y = self.term()?;
                x = if c == '+' { x + y } else { x - y };
            }
            Some(x)
        }
        fn term(&mut self) -> Option<f64> {
            let mut x = self.factor()?;
            while let Some(Tok::Op(c @ ('*' | '/'))) = self.t.get(self.i) {
                let c = *c;
                self.i += 1;
                let y = self.factor()?;
                x = if c == '*' { x * y } else if y == 0.0 { 0.0 } else { x / y };
            }
            Some(x)
        }
        fn factor(&mut self) -> Option<f64> {
            self.depth += 1;
            if self.depth > 200 {
                return None;
            }
            let r = match self.t.get(self.i)?.clone() {
                Tok::Num(n) => {
                    self.i += 1;
                    Some(n)
                }
                Tok::Name(n) => {
                    self.i += 1;
                    Some(self.v.get(&n).and_then(|s| make_number(s)).unwrap_or(0.0))
                }
                Tok::Op('-') => {
                    self.i += 1;
                    self.factor().map(|x| -x)
                }
                Tok::Op('+') => {
                    self.i += 1;
                    self.factor()
                }
                Tok::Op('(') => {
                    self.i += 1;
                    let x = self.expr()?;
                    matches!(self.t.get(self.i), Some(Tok::Op(')'))).then(|| self.i += 1)?;
                    Some(x)
                }
                _ => None,
            };
            self.depth -= 1;
            r
        }
    }
    let mut p = P { t: &toks, i: 0, v: values, depth: 0 };
    let x = p.expr()?;
    (p.i == toks.len()).then_some(x)
}

/* ------------------------------------------------------------------ validations standard */

#[derive(Debug, Clone, PartialEq)]
enum Validate {
    Range { min: Option<f64>, max: Option<f64> },
    Js(String),
    None,
}

fn parse_validate(src: &str) -> Validate {
    let s = src.trim();
    if s.is_empty() {
        return Validate::None;
    }
    if let Some(rest) = s.strip_prefix("AFRange_Validate") {
        let args: Vec<&str> = rest.trim().trim_end_matches(';').trim().trim_start_matches('(').trim_end_matches(')').split(',').map(str::trim).collect();
        if args.len() == 4 {
            let on = |x: &str| x == "true";
            let num = |x: &str| x.parse::<f64>().ok();
            return Validate::Range { min: if on(args[0]) { num(args[1]) } else { None }, max: if on(args[2]) { num(args[3]) } else { None } };
        }
    }
    Validate::Js(s.to_string())
}

/// La frappe n'accepte que des nombres (AFNumber_Keystroke, AFPercent_Keystroke).
fn numeric_keystroke(src: &str) -> bool {
    let s = src.trim_start();
    s.starts_with("AFNumber_Keystroke") || s.starts_with("AFPercent_Keystroke")
}

/* ------------------------------------------------------------------ QuickJS */

/// Fonctions offertes aux scripts. Tout le reste (app, fichiers, réseau…) est absent.
const PRELUDE: &str = r#"
(function () {
  "use strict";
  const input = JSON.parse(globalThis.__in);
  delete globalThis.__in;
  const values = input.fields;
  const changed = {};
  const alerts = [];
  function num(v) {
    const t = String(v).replace(/[\s  ]/g, "");
    if (t === "") return null;
    const n = Number(t.indexOf(",") >= 0 && t.indexOf(".") < 0 ? t.replace(",", ".") : t.replace(/,/g, ""));
    return isFinite(n) ? n : null;
  }
  function field(name) {
    name = String(name);
    if (!Object.prototype.hasOwnProperty.call(values, name)) return null;
    return {
      name: name,
      get value() { const v = values[name]; const n = num(v); return n === null ? v : n; },
      set value(v) { values[name] = v === null || v === undefined ? "" : String(v); changed[name] = values[name]; },
      get valueAsString() { return values[name]; },
      readonly: false,
    };
  }
  globalThis.AFMakeNumber = function (v) { return num(v); };
  globalThis.getField = field;
  globalThis.event = { value: input.value, rc: true, willCommit: true, name: input.event, target: field(input.target) || { name: input.target }, targetName: input.target };
  globalThis.app = { alert: function (m) { alerts.push(String(m && m.cMsg !== undefined ? m.cMsg : m)); return 1; }, beep: function () {} };
  globalThis.console = { println: function () {} };
  globalThis.util = { printf: function (f) { return String(f); } };
  globalThis.AFSimple_Calculate = function (op, list) {
    const names = typeof list === "string" ? list.split(",").map(function (x) { return x.trim(); }) : list;
    const ns = names.map(function (n) { const f = field(n); return f ? (num(values[n]) || 0) : 0; });
    let r = 0;
    if (op === "SUM") r = ns.reduce(function (a, b) { return a + b; }, 0);
    else if (op === "PRD") r = ns.reduce(function (a, b) { return a * b; }, 1);
    else if (op === "AVG") r = ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) / ns.length : 0;
    else if (op === "MIN") r = Math.min.apply(null, ns);
    else if (op === "MAX") r = Math.max.apply(null, ns);
    event.value = r;
  };
  globalThis.AFRange_Validate = function (bG, nG, bL, nL) {
    const n = num(event.value);
    if (n === null) return;
    if ((bG && n < nG) || (bL && n > nL)) event.rc = false;
  };
  ["AFNumber_Format", "AFNumber_Keystroke", "AFPercent_Format", "AFPercent_Keystroke", "AFDate_FormatEx", "AFDate_KeystrokeEx",
   "AFDate_Format", "AFDate_Keystroke", "AFSpecial_Format", "AFSpecial_Keystroke", "AFSpecial_KeystrokeEx", "AFTime_Format", "AFTime_Keystroke"]
    .forEach(function (n) { globalThis[n] = function () {}; });
  globalThis.__out = function () {
    const v = event.value;
    return JSON.stringify({ value: v === null || v === undefined ? "" : String(v), rc: event.rc !== false, changed: changed, alerts: alerts });
  };
})();
"#;

#[derive(Debug, serde::Deserialize)]
struct JsOut {
    value: String,
    rc: bool,
    changed: HashMap<String, String>,
    alerts: Vec<String>,
}

/// Un script du document, isolé. `values` : valeurs de tous les champs ; `target` : le champ
/// concerné ; `value` : sa valeur (event.value).
fn run_js(script: &str, event: &str, target: &str, value: &str, values: &HashMap<String, String>) -> Result<JsOut> {
    let rt = rquickjs::Runtime::new()?;
    rt.set_memory_limit(JS_MEMORY);
    rt.set_max_stack_size(512 * 1024);
    let deadline = Rc::new(Cell::new(Instant::now() + JS_TIME));
    let d = deadline.clone();
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() > d.get())));
    let ctx = rquickjs::Context::full(&rt)?;
    let input = serde_json::json!({ "fields": values, "target": target, "value": value, "event": event }).to_string();
    ctx.with(|ctx| -> Result<JsOut> {
        let fail = |e: rquickjs::Error| anyhow::anyhow!("script : {e}");
        ctx.globals().set("__in", input).map_err(fail)?;
        ctx.eval::<(), _>(PRELUDE).map_err(fail)?;
        deadline.set(Instant::now() + JS_TIME);
        ctx.eval::<rquickjs::Value, _>(script.as_bytes().to_vec()).map_err(fail)?;
        let out: String = ctx.eval("__out()").map_err(fail)?;
        serde_json::from_str(&out).context("sortie du script illisible")
    })
}

/* ------------------------------------------------------------------ saisie forcée */

/// Écrit une valeur calculée dans un champ texte, même en lecture seule (le drapeau est levé le
/// temps de la saisie, puis rétabli) : PDFium régénère alors l'apparence comme pour une frappe.
fn force_set(doc: &PdfDocument, page_index: i32, index: i32, value: &str) -> Result<()> {
    let page = doc.pages().get(page_index).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    crate::fill::set_field_opts(doc, &page, index, &FieldInput::Text { value: value.to_string() }, true)
}

/* ------------------------------------------------------------------ après une saisie */

/// Valide la saisie du champ (`page`, `index`) dont la valeur précédente était `old`, puis
/// recalcule les champs calculés jusqu'à stabilité. Une saisie refusée est annulée.
pub fn after_change(doc: &PdfDocument, page: i32, index: i32, old: &str, run_js_scripts: bool) -> Result<Outcome> {
    let mut out = Outcome::default();
    let mut fields = collect(doc);
    if !has_scripts(&fields) {
        return Ok(out);
    }
    let mut values: HashMap<String, String> = fields.iter().map(|f| (f.name.clone(), f.value.clone())).collect();
    let Some(target) = fields.iter().find(|f| f.page == page && f.index == index).cloned().or_else(|| {
        // Un autre widget du même champ (bouton radio, champ répété) : le nom suffit.
        let p = doc.pages().get(page).ok()?;
        let fl = crate::fill::fields(doc, &p, page);
        let name = fl.iter().find(|f| f.index == index)?.name.clone();
        fields.iter().find(|f| f.name == name).cloned()
    }) else {
        return Ok(out);
    };

    // 1. Contrôle de saisie (nombre attendu) puis validation du champ saisi.
    let mut reject: Option<String> = None;
    if target.text && numeric_keystroke(&target.keystroke) && !target.value.trim().is_empty() && make_number(&target.value).is_none() {
        reject = Some("number".into());
    }
    if reject.is_none() {
        match parse_validate(&target.validate) {
            Validate::Range { min, max } => {
                if let Some(n) = make_number(&target.value) {
                    if min.is_some_and(|m| n < m) || max.is_some_and(|m| n > m) {
                        reject = Some(match (min, max) {
                            (Some(a), Some(b)) => format!("range:{}:{}", format_number(a), format_number(b)),
                            (Some(a), None) => format!("min:{}", format_number(a)),
                            (None, Some(b)) => format!("max:{}", format_number(b)),
                            _ => "invalid".into(),
                        });
                    }
                }
            }
            Validate::Js(src) if run_js_scripts => match run_js(&src, "Validate", &target.name, &target.value, &values) {
                Ok(r) => {
                    out.alerts.extend(r.alerts.iter().cloned());
                    if !r.rc {
                        reject = Some(r.alerts.first().cloned().map(|a| format!("message:{a}")).unwrap_or_else(|| "invalid".into()));
                    }
                }
                Err(_) => out.script_errors += 1,
            },
            _ => {}
        }
    }
    if let Some(why) = reject {
        if target.text {
            force_set(doc, target.page, target.index, old)?;
        }
        out.rejected = Some(why);
        out.changed_pages.push(target.page);
        return Ok(out);
    }

    // 2. Champs calculés, dans l'ordre du document, jusqu'à stabilité.
    let mut changed: BTreeSet<i32> = BTreeSet::new();
    for _ in 0..MAX_PASSES {
        let mut any = false;
        for f in fields.iter_mut().filter(|f| f.text && !f.calculate.trim().is_empty()) {
            let computed = match parse_calc(&f.calculate) {
                Calc::Aggregate { op, fields: names } => {
                    let nums = values_of(&names, &values);
                    if nums.is_empty() && (op == "MIN" || op == "MAX") { Some(String::new()) } else { Some(format_number(aggregate(&op, &nums))) }
                }
                Calc::Expr(e) => eval_sfn(&e, &values).map(format_number),
                Calc::Js(src) if run_js_scripts => match run_js(&src, "Calculate", &f.name, &f.value, &values) {
                    Ok(r) => {
                        out.alerts.extend(r.alerts);
                        // Champs modifiés directement par le script.
                        for (k, v) in r.changed {
                            if k != f.name && values.get(&k) != Some(&v) {
                                values.insert(k, v);
                            }
                        }
                        Some(r.value)
                    }
                    Err(_) => {
                        out.script_errors += 1;
                        None
                    }
                },
                _ => None,
            };
            if let Some(v) = computed {
                if v != f.value {
                    force_set(doc, f.page, f.index, &v)?;
                    f.value = v.clone();
                    values.insert(f.name.clone(), v);
                    changed.insert(f.page);
                    any = true;
                }
            }
        }
        if !any {
            break;
        }
    }
    out.changed_pages = changed.into_iter().collect();
    Ok(out)
}

/// Pour les tests : exécute un script isolé et renvoie (valeur, rc).
pub fn run_script_for_test(script: &str, values: &[(&str, &str)]) -> Result<(String, bool)> {
    let map: HashMap<String, String> = values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    run_js(script, "Calculate", "test", "", &map).map(|r| (r.value, r.rc))
}

/// Pour les tests : la notation simplifiée.
pub fn sfn_for_test(expr: &str, values: &[(&str, &str)]) -> Option<f64> {
    let map: HashMap<String, String> = values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    eval_sfn(expr, &map)
}
