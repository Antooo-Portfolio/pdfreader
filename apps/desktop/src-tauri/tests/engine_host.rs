//! Processus moteur (`PDFReader.exe --engine-host`) piloté comme le fait l'application : ouverture
//! sous le numéro choisi par l'application, tuiles, surcoût de l'aller-retour par rapport à un rendu
//! dans le même processus, flux corrompu refusé proprement, plantage volontaire (test seulement)
//! qui arrête le moteur sans toucher à l'appelant.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn lib_dir() -> PathBuf {
    root().join("vendor").join("pdfium-win-x64").join("bin")
}

struct Host {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    next: u64,
}

impl Host {
    fn start(e2e: bool) -> Host {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_pdfreader-desktop"));
        cmd.arg("--engine-host").arg(lib_dir()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        if e2e {
            cmd.env("PDFREADER_E2E", root().join("target").join("engine-host-test.json"));
        } else {
            cmd.env_remove("PDFREADER_E2E");
        }
        let mut child = cmd.spawn().expect("lancement du moteur");
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        Host { child, input, output, next: 1 }
    }

    fn write_raw(&mut self, head: &[u8], data: &[u8]) -> std::io::Result<()> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(head.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(head);
        buf.extend_from_slice(data);
        let input = self.input.as_mut().unwrap();
        input.write_all(&buf)?;
        input.flush()
    }

    /// Envoie une demande ; renvoie son numéro.
    fn send(&mut self, mut req: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        req["id"] = json!(id);
        self.write_raw(&serde_json::to_vec(&req).unwrap(), &[]).expect("écriture");
        id
    }

    /// Lit une trame ; `None` en fin de flux.
    fn read(&mut self) -> Option<(Value, Vec<u8>)> {
        let mut lens = [0u8; 8];
        self.output.read_exact(&mut lens).ok()?;
        let hl = u32::from_le_bytes(lens[..4].try_into().unwrap()) as usize;
        let dl = u32::from_le_bytes(lens[4..].try_into().unwrap()) as usize;
        let mut head = vec![0u8; hl];
        self.output.read_exact(&mut head).ok()?;
        let mut data = vec![0u8; dl];
        self.output.read_exact(&mut data).ok()?;
        Some((serde_json::from_slice(&head).unwrap(), data))
    }

    fn call(&mut self, req: Value) -> (Value, Vec<u8>) {
        let id = self.send(req);
        let (head, data) = self.read().expect("réponse");
        assert_eq!(head["id"], json!(id));
        (head, data)
    }

    /// Attend la fin du processus (au plus quelques secondes).
    fn wait_exit(&mut self) -> std::process::ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "le moteur ne s'arrête pas");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn corpus(name: &str) -> PathBuf {
    root().join("corpus").join("generated").join(name)
}

#[test]
fn engine_host_round_trip_crash_and_garbage() {
    if !lib_dir().join("pdfium.dll").exists() || !corpus("01-texte-10p.pdf").exists() {
        eprintln!("PDFium ou corpus absent : test ignoré");
        return;
    }
    let pdf = corpus("01-texte-10p.pdf");
    let mut host = Host::start(false);

    // Ouverture sous le numéro choisi par l'application ; la miniature arrive en binaire.
    let (head, thumb) = host.call(json!({ "cmd": "Open", "doc": 0, "path": pdf, "shown_as": null, "password": null, "generation": 5 }));
    assert_eq!(head["t"], "ok", "{head}");
    let info = &head["value"]["info"];
    assert_eq!(info["id"], 0);
    assert_eq!(info["pageCount"], 10);
    assert_eq!(info["generation"], 5);
    assert!(thumb.starts_with(b"\x89PNG"), "miniature PNG");

    // Erreur typée pour un fichier absent.
    let (head, _) = host.call(json!({ "cmd": "Open", "doc": 1, "path": root().join("absent.pdf"), "shown_as": null, "password": null, "generation": 1 }));
    assert_eq!(head["t"], "err");
    assert_eq!(head["error"]["kind"], "not_found");

    // Tuiles : WebP dans les données binaires. Surcoût de l'aller-retour mesuré contre un rendu
    // fait directement dans ce processus.
    let tiles: Vec<(i32, i32, i32)> = (0..10).flat_map(|p| [(p, 0, 0), (p, 1, 0)]).collect();
    for _ in 0..2 {
        host.call(json!({ "cmd": "Tile", "doc": 0, "page": 0, "scale": 1.5, "x": 0, "y": 0, "size": 512 }));
    }
    let start = Instant::now();
    for &(page, x, y) in &tiles {
        let (head, webp) = host.call(json!({ "cmd": "Tile", "doc": 0, "page": page, "scale": 1.5, "x": x, "y": y, "size": 512 }));
        assert_eq!(head["t"], "ok", "{head}");
        assert!(webp.starts_with(b"RIFF") && &webp[8..12] == b"WEBP");
    }
    let ipc = start.elapsed() / tiles.len() as u32;

    let pdfium = pdfreader_engine::load_pdfium(&lib_dir()).unwrap();
    let doc = pdfreader_engine::open_typed(&pdfium, &pdf, None).unwrap();
    for _ in 0..2 {
        let p = doc.pages().get(0).unwrap();
        pdfreader_engine::tile_webp(&pdfreader_engine::render_tile(&p, 1.5, 0, 0, 512).unwrap()).unwrap();
    }
    let start = Instant::now();
    for &(page, x, y) in &tiles {
        let p = doc.pages().get(page).unwrap();
        pdfreader_engine::tile_webp(&pdfreader_engine::render_tile(&p, 1.5, x, y, 512).unwrap()).unwrap();
    }
    let direct = start.elapsed() / tiles.len() as u32;
    eprintln!("tuile : {ipc:?} par le moteur séparé, {direct:?} dans le même processus");
    assert!(ipc < direct + Duration::from_millis(5), "surcoût trop élevé : {ipc:?} contre {direct:?}");

    // Hors test, la demande de plantage est refusée.
    let (head, _) = host.call(json!({ "cmd": "TestCrash", "doc": 0 }));
    assert_eq!(head["t"], "err");

    // Flux corrompu : le moteur s'arrête proprement (fin de lecture), sans planter.
    host.write_raw(b"{pas du json", &[]).unwrap();
    assert!(host.read().is_none());
    assert!(host.wait_exit().success());

    // Plantage volontaire (tests seulement) : seul le moteur s'arrête, l'appelant lit une fin de flux.
    let mut host = Host::start(true);
    let (head, _) = host.call(json!({ "cmd": "Open", "doc": 3, "path": pdf, "shown_as": null, "password": null, "generation": 1 }));
    assert_eq!(head["t"], "ok");
    host.send(json!({ "cmd": "TestCrash", "doc": 3 }));
    assert!(host.read().is_none());
    assert!(!host.wait_exit().success());

    // Entrée fermée (application partie) : le moteur s'arrête de lui-même.
    let mut host = Host::start(false);
    host.input = None;
    assert!(host.wait_exit().success());
}
