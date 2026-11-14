//! Côté application du moteur PDF. PDFium tourne dans un processus à part (le même exécutable,
//! lancé avec `--engine-host`, voir `host.rs`) : un PDF malformé qui le fait planter ou le bloque
//! n'emporte pas l'application. Ce module envoie les demandes, attend les réponses, surveille le
//! moteur et, s'il tombe ou ne répond plus, le relance et rouvre les documents sous le même numéro
//! (depuis leur dernière copie de récupération s'il y en a une). L'interface est prévenue par
//! l'événement « engine-restarted ».

use std::collections::{BTreeMap, HashMap};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager, UriSchemeResponder};
use tokio::sync::oneshot;

pub use crate::protocol::{AnnotOp, DocInfo, OpenResult, Request, SaveResult};
use crate::protocol::{Answer, Envelope, read_frame, write_frame};

/// Pourquoi une demande n'a pas abouti.
#[derive(Debug)]
pub enum Fail {
    /// Erreur renvoyée par le moteur (texte, ou erreur d'ouverture typée).
    Engine(Value),
    /// Le moteur s'est arrêté pendant la demande (il est relancé).
    Restarted,
    /// Le moteur ne peut pas être lancé.
    Unavailable(String),
}

impl Fail {
    pub fn message(self) -> String {
        match self {
            Fail::Engine(Value::String(s)) => s,
            Fail::Engine(v) => v.to_string(),
            Fail::Restarted => "engine_restarted".into(),
            Fail::Unavailable(s) => s,
        }
    }
}

type Done = Result<(Value, Vec<u8>), Fail>;
type Progress = Box<dyn Fn(usize, usize) + Send>;

enum Sink {
    Reply(oneshot::Sender<Done>),
    Tile(UriSchemeResponder),
    Ignore,
}

struct Pending {
    doc: Option<u32>,
    sent: Instant,
    patience: Duration,
    print: bool,
    progress: Option<Progress>,
    sink: Sink,
}

/// Ce qu'il faut pour rouvrir un document après un redémarrage du moteur.
#[derive(Clone)]
struct DocRecord {
    /// Fichier lu (une copie de récupération, pour un document restauré).
    source: PathBuf,
    /// Chemin présenté (et d'enregistrement), s'il diffère du fichier lu.
    shown: Option<PathBuf>,
    password: Option<String>,
    generation: u32,
}

impl DocRecord {
    fn shown(&self) -> &Path {
        self.shown.as_deref().unwrap_or(&self.source)
    }
}

struct Conn {
    stdin: ChildStdin,
    child: Child,
}

/// Ce que l'interface doit apprendre du prochain redémarrage (cumulé si le moteur retombe pendant
/// qu'on rouvre les documents).
#[derive(Default)]
struct Notice {
    reason: Option<&'static str>,
    culprit: Option<u32>,
    closed: Vec<u32>,
}

struct State {
    conn: Option<Conn>,
    epoch: u64,
    pending: BTreeMap<u64, Pending>,
    docs: HashMap<u32, DocRecord>,
    /// Arrêts attribués à chaque document : au deuxième, il n'est plus rouvert.
    crashes: HashMap<u32, u32>,
    last_activity: Instant,
    /// Le moteur a été arrêté par la surveillance (il ne répondait plus).
    killed_for_hang: bool,
    /// Instants des derniers arrêts, pour ne pas relancer sans fin un moteur qui ne démarre pas.
    recent_exits: Vec<Instant>,
    broken: Option<String>,
    notice: Notice,
}

struct Shared {
    lib_dir: PathBuf,
    state: Mutex<State>,
    /// Un seul redémarrage à la fois.
    restart: Mutex<()>,
    app: OnceLock<AppHandle>,
    next_req: AtomicU64,
    next_doc: AtomicU32,
    #[cfg(windows)]
    job: Option<job::Job>,
}

/// Mémoire maximale du processus moteur : au-delà, une allocation échoue et le moteur s'arrête
/// (bombe de décompression, image démesurée) au lieu d'épuiser la machine.
const ENGINE_MEMORY: usize = 4 << 30;

#[derive(Clone)]
pub struct Engine(Arc<Shared>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReopenedDoc {
    id: u32,
    info: DocInfo,
    /// « snapshot » : rouvert depuis la dernière copie de récupération ; « file » : depuis le fichier.
    from: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RestartEvent {
    reason: &'static str,
    culprit: Option<u32>,
    docs: Vec<ReopenedDoc>,
    closed: Vec<u32>,
}

impl Engine {
    /// Lance le moteur. `lib_dir` : dossier qui contient pdfium.dll.
    pub fn start(lib_dir: PathBuf) -> Engine {
        let shared = Arc::new(Shared {
            lib_dir,
            state: Mutex::new(State {
                conn: None,
                epoch: 0,
                pending: BTreeMap::new(),
                docs: HashMap::new(),
                crashes: HashMap::new(),
                last_activity: Instant::now(),
                killed_for_hang: false,
                recent_exits: Vec::new(),
                broken: None,
                notice: Notice::default(),
            }),
            restart: Mutex::new(()),
            app: OnceLock::new(),
            next_req: AtomicU64::new(1),
            next_doc: AtomicU32::new(1),
            #[cfg(windows)]
            job: job::Job::new(ENGINE_MEMORY),
        });
        let engine = Engine(shared);
        if let Err(e) = engine.spawn() {
            eprintln!("moteur PDF : lancement impossible : {e}");
            engine.0.state.lock().unwrap().broken = Some(format!("Le moteur PDF n'a pas pu démarrer ({e})."));
        }
        let watch = engine.clone();
        std::thread::Builder::new().name("surveillance-moteur".into()).spawn(move || watch.watchdog()).expect("fil de surveillance");
        engine
    }

    /// Application (événements, base locale pour retrouver les copies de récupération).
    pub fn attach(&self, app: AppHandle) {
        let _ = self.0.app.set(app);
    }

    fn spawn(&self) -> std::io::Result<()> {
        let exe = std::env::current_exe()?;
        let mut cmd = Command::new(exe);
        cmd.arg("--engine-host").arg(&self.0.lib_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        if let Some(job) = &self.0.job
            && !job.assign(&child)
        {
            eprintln!("moteur PDF : limites du processus non appliquées");
        }
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("entrée du moteur"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("sortie du moteur"))?;
        let epoch = {
            let mut s = self.0.state.lock().unwrap();
            s.epoch += 1;
            s.conn = Some(Conn { stdin, child });
            s.last_activity = Instant::now();
            s.epoch
        };
        let me = self.clone();
        std::thread::Builder::new()
            .name("réponses-moteur".into())
            .spawn(move || me.read_answers(BufReader::new(stdout), epoch))
            .expect("fil de lecture du moteur");
        Ok(())
    }

    /// Numéro du prochain document (choisi ici, pour qu'il survive aux redémarrages du moteur).
    pub fn new_doc_id(&self) -> u32 {
        self.0.next_doc.fetch_add(1, Ordering::Relaxed)
    }

    fn submit(&self, req: Request, data: &[u8], sink: Sink, progress: Option<Progress>) {
        let id = self.0.next_req.fetch_add(1, Ordering::Relaxed);
        let mut s = self.0.state.lock().unwrap();
        let fail = |sink: Sink, f: Fail| complete(sink, Err(f));
        if let Some(b) = &s.broken {
            let b = b.clone();
            drop(s);
            return fail(sink, Fail::Unavailable(b));
        }
        let Some(conn) = s.conn.as_mut() else {
            drop(s);
            return fail(sink, Fail::Restarted);
        };
        let pending = Pending { doc: req.doc(), sent: Instant::now(), patience: patience(&req), print: matches!(req, Request::Print { .. }), progress, sink };
        if write_frame(&mut conn.stdin, &Envelope { id, req }, data).is_err() {
            // Le moteur vient de s'arrêter : le fil de lecture s'en occupe.
            drop(s);
            return complete(pending.sink, Err(Fail::Restarted));
        }
        s.pending.insert(id, pending);
    }

    /// Envoie une demande et attend la réponse (valeur JSON et données binaires).
    pub async fn call(&self, req: Request, data: Vec<u8>) -> Done {
        let (tx, rx) = oneshot::channel();
        self.submit(req, &data, Sink::Reply(tx), None);
        rx.await.unwrap_or(Err(Fail::Restarted))
    }

    fn call_blocking(&self, req: Request) -> Done {
        let (tx, rx) = oneshot::channel();
        self.submit(req, &[], Sink::Reply(tx), None);
        rx.blocking_recv().unwrap_or(Err(Fail::Restarted))
    }

    /// Demande dont la réponse est relue en type Rust ; l'erreur est un message.
    pub async fn ask<T: DeserializeOwned>(&self, req: Request) -> Result<T, String> {
        let (v, _) = self.call(req, Vec::new()).await.map_err(Fail::message)?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// Demande sans attente de réponse (fermeture, annulation d'impression).
    pub fn send(&self, req: Request) {
        if let Request::Close { doc } = req {
            self.0.state.lock().unwrap().docs.remove(&doc);
        }
        self.submit(req, &[], Sink::Ignore, None);
    }

    /// Tuile pour le protocole `pdfpage://` : la réponse HTTP part dès que le moteur a rendu.
    pub fn tile(&self, req: Request, responder: UriSchemeResponder) {
        self.submit(req, &[], Sink::Tile(responder), None);
    }

    /// Impression, avec la progression page par page.
    pub async fn print(&self, req: Request, progress: Progress) -> Result<usize, String> {
        #[cfg(windows)]
        if let Some(pid) = self.0.state.lock().unwrap().conn.as_ref().map(|c| c.child.id()) {
            // Le pilote peut ouvrir sa propre fenêtre (« Enregistrer sous » de Microsoft Print to PDF)
            // depuis le moteur : elle a le droit de passer devant.
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid);
            }
        }
        let (tx, rx) = oneshot::channel();
        self.submit(req, &[], Sink::Reply(tx), Some(progress));
        let (v, _) = rx.await.unwrap_or(Err(Fail::Restarted)).map_err(Fail::message)?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    /// Ouvre un document sous un nouveau numéro ; renvoie aussi la miniature (PNG).
    pub async fn open(&self, path: PathBuf, shown_as: Option<PathBuf>, password: Option<String>) -> Result<(OpenResult, Vec<u8>), pdfreader_engine::OpenError> {
        use pdfreader_engine::OpenError;
        let id = self.new_doc_id();
        let req = Request::Open { doc: id, path: path.clone(), shown_as: shown_as.clone(), password: password.clone(), generation: 1 };
        let (v, thumb) = self.call(req, Vec::new()).await.map_err(|f| match f {
            Fail::Engine(v) => serde_json::from_value::<OpenError>(v.clone()).unwrap_or_else(|_| OpenError::Other(Fail::Engine(v).message())),
            other => OpenError::Other(other.message()),
        })?;
        let r: OpenResult = serde_json::from_value(v).map_err(|e| OpenError::Other(e.to_string()))?;
        self.0.state.lock().unwrap().docs.insert(id, DocRecord { source: path, shown: shown_as, password, generation: r.info.generation });
        Ok((r, thumb))
    }

    pub async fn save(&self, doc: u32, path: Option<PathBuf>) -> Result<SaveResult, String> {
        let r: SaveResult = self.ask(Request::Save { doc, path }).await?;
        if let Some(d) = self.0.state.lock().unwrap().docs.get_mut(&doc) {
            d.source = PathBuf::from(&r.path);
            d.shown = None;
            d.generation = r.generation;
        }
        Ok(r)
    }

    pub async fn reload(&self, doc: u32) -> Result<DocInfo, String> {
        let info: DocInfo = self.ask(Request::Reload { doc }).await?;
        if let Some(d) = self.0.state.lock().unwrap().docs.get_mut(&doc) {
            d.source = PathBuf::from(&info.path);
            d.shown = None;
            d.generation = info.generation;
        }
        Ok(info)
    }

    // -------------------------------------------------------------- réponses et arrêts

    fn read_answers(&self, mut out: BufReader<std::process::ChildStdout>, epoch: u64) {
        loop {
            let frame = read_frame::<Answer>(&mut out);
            let Ok(Some((answer, data))) = frame else { break };
            let mut s = self.0.state.lock().unwrap();
            if s.epoch != epoch {
                return;
            }
            s.last_activity = Instant::now();
            match answer {
                Answer::Progress { id, done, total } => {
                    if let Some(p) = s.pending.get(&id).and_then(|p| p.progress.as_ref()) {
                        p(done, total);
                    }
                }
                Answer::Ok { id, value } => {
                    if let Some(p) = s.pending.remove(&id) {
                        drop(s);
                        complete(p.sink, Ok((value, data)));
                    }
                }
                Answer::Err { id, error } => {
                    if let Some(p) = s.pending.remove(&id) {
                        drop(s);
                        complete(p.sink, Err(Fail::Engine(error)));
                    }
                }
            }
        }
        self.on_exit(epoch);
    }

    /// Le moteur s'est arrêté (plantage, blocage interrompu) : on termine les demandes en cours,
    /// on le relance et on rouvre les documents.
    fn on_exit(&self, epoch: u64) {
        let pending = {
            let mut s = self.0.state.lock().unwrap();
            if s.epoch != epoch {
                return;
            }
            let Some(mut conn) = s.conn.take() else { return };
            let _ = conn.child.kill();
            let status = conn.child.wait().ok();
            let reason = if std::mem::take(&mut s.killed_for_hang) { "hang" } else { "crash" };
            eprintln!("moteur PDF arrêté ({reason}, {status:?})");
            let pending = std::mem::take(&mut s.pending);
            // Le moteur traite les demandes dans l'ordre : la plus ancienne en attente est celle
            // qui l'a fait tomber.
            let culprit = pending.values().find_map(|p| p.doc).filter(|d| s.docs.contains_key(d));
            if let Some(c) = culprit {
                *s.crashes.entry(c).or_default() += 1;
            }
            let n = &mut s.notice;
            n.reason = Some(match (n.reason, reason) {
                (Some("hang"), _) | (_, "hang") => "hang",
                _ => "crash",
            });
            n.culprit = n.culprit.or(culprit);
            let now = Instant::now();
            s.recent_exits.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
            s.recent_exits.push(now);
            pending
        };
        for (_, p) in pending {
            complete(p.sink, Err(Fail::Restarted));
        }
        let me = self.clone();
        std::thread::Builder::new().name("relance-moteur".into()).spawn(move || me.restart()).expect("fil de relance");
    }

    fn restart(&self) {
        let _one = self.0.restart.lock().unwrap();
        {
            let mut s = self.0.state.lock().unwrap();
            if s.conn.is_some() || s.broken.is_some() {
                return; // déjà relancé par un autre arrêt
            }
            if s.recent_exits.len() >= 5 {
                s.broken = Some("Le moteur PDF s'arrête sans cesse : redémarrez PDFReader.".into());
            }
        }
        let broken = self.0.state.lock().unwrap().broken.clone();
        if broken.is_none()
            && let Err(e) = self.spawn()
        {
            self.0.state.lock().unwrap().broken = Some(format!("Le moteur PDF n'a pas pu redémarrer ({e})."));
        }
        if self.0.state.lock().unwrap().broken.is_some() {
            let (notice, closed) = {
                let mut s = self.0.state.lock().unwrap();
                let closed: Vec<u32> = s.docs.drain().map(|(id, _)| id).collect();
                (std::mem::take(&mut s.notice), closed)
            };
            let mut all = notice.closed;
            all.extend(closed);
            self.emit(RestartEvent { reason: "unavailable", culprit: notice.culprit, docs: Vec::new(), closed: all });
            return;
        }
        // Documents à rouvrir, dans l'ordre d'ouverture. Celui qui a déjà fait tomber le moteur
        // deux fois reste fermé.
        let docs: Vec<(u32, DocRecord)> = {
            let mut s = self.0.state.lock().unwrap();
            let doomed: Vec<u32> = s.docs.keys().copied().filter(|id| s.crashes.get(id).copied().unwrap_or(0) >= 2).collect();
            for id in &doomed {
                s.docs.remove(id);
                s.notice.closed.push(*id);
            }
            let mut v: Vec<_> = s.docs.iter().map(|(k, d)| (*k, d.clone())).collect();
            v.sort_by_key(|(k, _)| *k);
            v
        };
        let mut reopened = Vec::new();
        for (id, rec) in docs {
            let (source, shown, from) = match self.snapshot_for(rec.shown()) {
                Some(snap) => (snap, Some(rec.shown().to_path_buf()), "snapshot"),
                None if rec.shown.is_some() && rec.source.exists() => (rec.source.clone(), rec.shown.clone(), "snapshot"),
                None => (rec.shown().to_path_buf(), None, "file"),
            };
            let req = Request::Open { doc: id, path: source.clone(), shown_as: shown.clone(), password: rec.password.clone(), generation: rec.generation + 1 };
            match self.call_blocking(req) {
                Ok((v, _)) => {
                    let Ok(r) = serde_json::from_value::<OpenResult>(v) else { continue };
                    let mut s = self.0.state.lock().unwrap();
                    if let Some(d) = s.docs.get_mut(&id) {
                        *d = DocRecord { source, shown, password: rec.password.clone(), generation: r.info.generation };
                    }
                    reopened.push(ReopenedDoc { id, info: r.info, from });
                }
                // Le moteur est retombé pendant la réouverture : le prochain redémarrage reprend tout.
                Err(Fail::Restarted) | Err(Fail::Unavailable(_)) => return,
                Err(Fail::Engine(_)) => {
                    // Fichier disparu ou illisible : le document est fermé.
                    let mut s = self.0.state.lock().unwrap();
                    s.docs.remove(&id);
                    s.notice.closed.push(id);
                }
            }
        }
        let notice = std::mem::take(&mut self.0.state.lock().unwrap().notice);
        self.emit(RestartEvent { reason: notice.reason.unwrap_or("crash"), culprit: notice.culprit, docs: reopened, closed: notice.closed });
    }

    /// Dernière copie de récupération du document (modifications non enregistrées).
    fn snapshot_for(&self, shown: &Path) -> Option<PathBuf> {
        let app = self.0.app.get()?;
        let db = app.try_state::<crate::db::Db>()?;
        let wanted = shown.display().to_string();
        db.snapshots().ok()?.into_iter().find(|s| s.1 == wanted).map(|s| PathBuf::from(s.2)).filter(|p| p.exists())
    }

    fn emit(&self, e: RestartEvent) {
        if let Some(app) = self.0.app.get() {
            let _ = app.emit("engine-restarted", e);
        }
    }

    /// Un moteur qui ne répond plus est arrêté : la relance suit le même chemin qu'un plantage.
    fn watchdog(&self) {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut s = self.0.state.lock().unwrap();
            // Pendant une impression, le pilote peut attendre l'utilisateur (choix du fichier) :
            // pas de surveillance.
            if s.conn.is_none() || s.pending.values().any(|p| p.print) {
                continue;
            }
            let Some(oldest) = s.pending.values().next() else { continue };
            let since = oldest.sent.max(s.last_activity);
            if since.elapsed() > oldest.patience {
                s.killed_for_hang = true;
                if let Some(c) = s.conn.as_mut() {
                    let _ = c.child.kill();
                }
            }
        }
    }
}

/// Délai de patience d'une demande ; raccourci pour les tests de bout en bout.
fn patience(req: &Request) -> Duration {
    let p = req.patience();
    if p <= Duration::from_secs(30)
        && let Some(ms) = std::env::var("PDFREADER_E2E").ok().and(std::env::var("PDFREADER_E2E_WATCHDOG_MS").ok()).and_then(|v| v.parse().ok())
    {
        return Duration::from_millis(ms);
    }
    p
}

fn complete(sink: Sink, r: Done) {
    match sink {
        Sink::Reply(tx) => {
            let _ = tx.send(r);
        }
        Sink::Tile(responder) => match r {
            Ok((_, webp)) => respond(responder, 200, "image/webp", webp),
            Err(Fail::Engine(e)) => respond(responder, 404, "text/plain", Fail::Engine(e).message().into_bytes()),
            Err(f) => respond(responder, 503, "text/plain", f.message().into_bytes()),
        },
        Sink::Ignore => {}
    }
}

fn respond(responder: UriSchemeResponder, status: u16, content_type: &str, body: Vec<u8>) {
    let mut b = Response::builder().status(status).header("Content-Type", content_type).header("Access-Control-Allow-Origin", "*");
    if status == 200 {
        // L'URL contient la génération du document et la version de la page : immuable.
        b = b.header("Cache-Control", "public, max-age=31536000, immutable");
    } else {
        b = b.header("Cache-Control", "no-store");
    }
    responder.respond(b.body(body).unwrap());
}

#[cfg(windows)]
mod job {
    //! Objet de tâche Windows : le moteur meurt avec l'application, sa mémoire est plafonnée et
    //! une exception non gérée l'arrête sans boîte de dialogue.
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    pub struct Job(HANDLE);
    // Le descripteur est utilisé depuis plusieurs fils, sans état partagé côté Rust.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new(memory: usize) -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                info.ProcessMemoryLimit = memory;
                SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const core::ffi::c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
                    .ok()?;
                Some(Job(h))
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())).is_ok() }
        }
    }
}
