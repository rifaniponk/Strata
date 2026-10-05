/* serve/web/pcviz.js - the Monitor's live 3D PC.
 *
 * An open-side case whose parts are driven by this PC's real telemetry: the GPU's body takes a heat colour and its
 * fans spin with the load, RAM sticks fill, the SSD blinks on reads, PCIe traffic flows as particles from the board
 * to the card, and tokens stream out of the GPU while the model writes. Every geometry and texture is built here in
 * code - there are no model or image assets to load.
 *
 * Values arrive once a second from /metrics; the frame loop eases towards them, so the picture moves continuously
 * instead of stepping. The loop only runs while the Monitor tab is open and the page is visible.
 */
import * as THREE from "./three.module.js";

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x || 0);
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
// frame-rate independent easing: how far to move towards the target this frame
const ease = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));

const PARTS = {
  gpu: "Graphics card", cpu: "Processor", ram: "Memory", ssd: "Storage",
  psu: "Power supply", case: "Case", board: "Mainboard",
};

export function createPcViz(canvas) {
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: "low-power"});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 300);

  // ---------------------------------------------------------------- theme colours
  const COOL = new THREE.Color(), WARM = new THREE.Color(), HOT = new THREE.Color();
  const ACCENT = new THREE.Color(), ACCENT2 = new THREE.Color(), INK = new THREE.Color();
  const tmp = new THREE.Color();
  function readTheme() {
    COOL.set(css("--st-heat-cool", "#00e5ff"));
    WARM.set(css("--st-heat-warm", "#ffb020"));
    HOT.set(css("--st-heat-hot", "#ff3b5c"));
    ACCENT.set(css("--st-accent", "#00e5ff"));
    ACCENT2.set(css("--st-accent-2", "#ff2d9b"));
    INK.set(css("--st-ink-muted", "#78889c"));
  }
  readTheme();
  // the page can flip light/dark under us; the scene follows without reloading
  const themeWatch = new MutationObserver(() => { readTheme(); applyStaticColors(); });
  themeWatch.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});

  /** cool -> warm -> hot, by load/temperature fraction */
  function heat(t, out) {
    t = clamp01(t);
    return t < 0.5 ? out.copy(COOL).lerp(WARM, t * 2) : out.copy(WARM).lerp(HOT, (t - 0.5) * 2);
  }

  // ---------------------------------------------------------------- materials
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);
  const standard = (color, o = {}) => keep(new THREE.MeshStandardMaterial({color, roughness: 0.62, metalness: 0.35, ...o}));

  const matShell = standard("#090e14", {roughness: 0.88, metalness: 0.25, transparent: true, opacity: 0.97});
  const matPanelGlass = keep(new THREE.MeshStandardMaterial({
    color: "#0b1118", roughness: 0.1, metalness: 0.05, transparent: true, opacity: 0.07, side: THREE.DoubleSide}));
  const matBoard = standard("#0b1713", {roughness: 0.95, metalness: 0.1});
  const matDark = standard("#080c11", {roughness: 0.92, metalness: 0.2});
  const matMetal = standard("#1b232d", {roughness: 0.7, metalness: 0.45});
  const matBlade = standard("#121923", {roughness: 0.8, metalness: 0.15});
  const matGpu = standard("#0a0f15", {roughness: 0.95, metalness: 0.18, emissive: "#000000", emissiveIntensity: 1});
  const matCpu = standard("#0e141c", {roughness: 0.9, metalness: 0.25, emissive: "#000000", emissiveIntensity: 1});
  const matRam = standard("#101720", {roughness: 0.8, metalness: 0.3});
  const matLit = keep(new THREE.MeshBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.95}));
  const matEdge = keep(new THREE.LineBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.4}));
  const matTrace = keep(new THREE.LineBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.22}));

  function applyStaticColors() {
    matLit.color.copy(ACCENT);
    matEdge.color.copy(ACCENT);
    matTrace.color.copy(ACCENT);
    grid.material.color.copy(ACCENT);
    pcieMat.color.copy(ACCENT2);
    tokenMat.color.copy(ACCENT);
    keyLight.color.copy(ACCENT);
    rimLight.color.copy(ACCENT2);
  }

  // ---------------------------------------------------------------- lights
  // The hardware stays dark and matte on purpose: all the colour in this scene comes from the emissive parts (fans,
  // strips, LEDs, edges). A saturated key AND a saturated rim would mix back to white and wash the metal out, so the
  // key is near-neutral and only the rim carries the second neon.
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  const hemi = new THREE.HemisphereLight(0x8fc8e8, 0x05070a, 0.45);
  scene.add(hemi);
  // point lights are physical since r155: intensity is candela, so it falls off with distance squared (~26 units here)
  const keyLight = new THREE.PointLight(new THREE.Color("#cfe9f5"), 230, 120, 2);
  keyLight.position.set(16, 13, 22);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(ACCENT2.clone(), 170, 110, 2);
  rimLight.position.set(-19, 5, -13);
  scene.add(rimLight);
  // a soft fill from the open side, so the inside of the case is readable instead of a black hole
  const fillLight = new THREE.DirectionalLight(0xbcd8ea, 0.35);
  fillLight.position.set(-4, 7, 16);
  scene.add(fillLight);

  // ---------------------------------------------------------------- the stage: grid + contact shadow
  const grid = new THREE.GridHelper(70, 28, ACCENT.clone(), ACCENT.clone());
  grid.position.y = -9.2;
  grid.material.transparent = true;
  grid.material.opacity = 0.085;
  grid.material.vertexColors = false;      // GridHelper bakes its colours per vertex; off, so a theme flip retints it
  scene.add(grid);
  keep(grid.material);
  keep(grid.geometry);

  // a soft dark ellipse under the case, painted into a canvas (no image file to ship)
  const shadowTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d").createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, "rgba(0,0,0,.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    const ctx = c.getContext("2d");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return keep(new THREE.CanvasTexture(c));
  })();
  const contact = new THREE.Mesh(keep(new THREE.PlaneGeometry(34, 20)),
    keep(new THREE.MeshBasicMaterial({map: shadowTex, transparent: true, depthWrite: false})));
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = -9.1;
  scene.add(contact);

  // ---------------------------------------------------------------- helpers
  const box = (w, h, d) => keep(new THREE.BoxGeometry(w, h, d));
  function mesh(geo, mat, x, y, z, part) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (part) { m.userData.part = part; pickable.push(m); }
    return m;
  }
  function edgesOf(geo, mat) { return new THREE.LineSegments(keep(new THREE.EdgesGeometry(geo)), mat); }
  const pickable = [];

  /** a fan built in the XY plane, facing +Z; userData.spin is the part that rotates */
  function makeFan(radius, blades) {
    const g = new THREE.Group();
    // a square shroud with a round cut-out is what makes it read as a fan rather than a flower
    const bar = radius * 0.34;
    for (let i = 0; i < 4; i++) {
      const horizontal = i < 2;
      const f = new THREE.Mesh(box(horizontal ? radius * 2.3 : bar, horizontal ? bar : radius * 2.3, 0.5), matDark);
      f.position.set(horizontal ? 0 : (i === 2 ? -1 : 1) * (radius + bar * 0.4),
                     horizontal ? (i === 0 ? 1 : -1) * (radius + bar * 0.4) : 0, 0);
      g.add(f);
    }
    const hub = new THREE.Mesh(keep(new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, 0.45, 18)), matMetal);
    hub.rotation.x = Math.PI / 2;
    g.add(hub);
    const spin = new THREE.Group();
    const bladeGeo = box(radius * 0.8, radius * 0.34, 0.07);
    for (let i = 0; i < blades; i++) {
      const a = (i / blades) * Math.PI * 2;
      const b = new THREE.Mesh(bladeGeo, matBlade);
      b.position.set(Math.cos(a) * radius * 0.56, Math.sin(a) * radius * 0.56, 0);
      b.rotation.z = a + 0.55;
      b.rotation.y = 0.42;                       // pitched, so the blades catch the light as they turn
      spin.add(b);
    }
    g.add(spin);
    // the lit rim: this is the part that brightens with load
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(radius * 0.95, radius * 1.06, 40)),
      keep(new THREE.MeshBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.3, side: THREE.DoubleSide,
                                        blending: THREE.AdditiveBlending, depthWrite: false})));
    ring.position.z = 0.3;
    g.add(ring);
    g.userData.spin = spin;
    g.userData.ring = ring;
    return g;
  }

  // ---------------------------------------------------------------- the case
  const W = 10, H = 8, D = 4.6;                 // interior half-extents
  const shell = new THREE.Group();
  scene.add(shell);
  const panel = (geo, x, y, z) => { const m = mesh(geo, matShell, x, y, z, "case"); shell.add(m); return m; };
  // Only the floor, roof and back panel are solid; the sides are left as lit edges. A closed box hides its own
  // contents from every angle the camera can reach, and the open frame is what makes the parts readable.
  panel(box(W * 2, 0.5, D * 2), 0, -H, 0);                    // floor
  panel(box(W * 2, 0.5, D * 2), 0, H, 0);                     // roof
  panel(box(W * 2, H * 2, 0.4), 0, 0, -D);                    // back wall
  for (const sx of [-1, 1]) {                                  // side rails, so the frame still has a body
    shell.add(mesh(box(0.35, H * 2, 0.35), matShell, sx * W, 0, D - 0.2, "case"));
    shell.add(mesh(box(0.35, H * 2, 0.35), matShell, sx * W, 0, -D + 0.2, "case"));
  }
  // the open side is glass: barely there, but it catches the lights
  const glass = mesh(keep(new THREE.PlaneGeometry(W * 2, H * 2)), matPanelGlass, 0, 0, D, "case");
  shell.add(glass);
  // neon edge frame - the signature of the theme, and it reads as a case's lit trim
  const caseFrame = edgesOf(box(W * 2 + 0.5, H * 2 + 0.5, D * 2 + 0.5), matEdge);
  shell.add(caseFrame);

  // front light bar: the machine's "face", it breathes when idle and pulses while the model writes
  const faceBar = mesh(box(W * 1.5, 0.34, 0.3), matLit.clone(), 0, -H + 0.9, D - 0.1, "case");
  keep(faceBar.material);
  shell.add(faceBar);
  const powerLed = mesh(keep(new THREE.SphereGeometry(0.22, 14, 12)),
    keep(new THREE.MeshBasicMaterial({color: ACCENT.clone()})), W - 1.2, -H + 0.9, D - 0.1, "case");
  shell.add(powerLed);

  // ---------------------------------------------------------------- mainboard
  const boardGeo = box(13.5, 12.5, 0.35);
  const board = mesh(boardGeo, matBoard, -1.4, 1.6, -D + 0.6, "board");
  shell.add(board);
  // circuit traces: a few straight runs across the PCB, drawn as lines
  const tracePts = [];
  for (let i = 0; i < 9; i++) {
    const y = -4.2 + i * 1.15, x0 = -7.6, x1 = -1 + (i % 3) * 2.4;
    tracePts.push(x0, y, 0.2, x1, y, 0.2, x1, y, 0.2, x1 + 0.9, y + 0.9, 0.2);
  }
  const traceGeo = keep(new THREE.BufferGeometry());
  traceGeo.setAttribute("position", new THREE.Float32BufferAttribute(tracePts, 3));
  const traces = new THREE.LineSegments(traceGeo, matTrace);
  board.add(traces);

  // ---------------------------------------------------------------- CPU + cooler
  const cpu = new THREE.Group();
  cpu.position.set(-4.6, 4.2, -D + 2.4);
  shell.add(cpu);
  const cpuBlock = mesh(box(4, 4, 3.4), matCpu, 0, 0, 0, "cpu");
  cpu.add(cpuBlock);
  cpu.add(edgesOf(box(4, 4, 3.4), matEdge));
  const cpuFan = makeFan(1.7, 7);
  cpuFan.position.z = 1.85;
  cpu.add(cpuFan);
  // heat pipes
  for (const x of [-1.1, 0, 1.1]) {
    const pipe = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.17, 0.17, 3.6, 10)), matMetal);
    pipe.position.set(x, 1.9, -0.6);
    cpu.add(pipe);
  }

  // ---------------------------------------------------------------- RAM
  const ramGroup = new THREE.Group();
  ramGroup.position.set(1.6, 4.4, -D + 1.9);
  shell.add(ramGroup);
  const ramLights = [];
  const ramStickGeo = box(0.55, 5.4, 1.5);
  const ramLightGeo = box(0.3, 4.6, 0.12);
  for (let i = 0; i < 4; i++) {
    const stick = mesh(ramStickGeo, matRam, i * 0.95, 0, 0, "ram");
    ramGroup.add(stick);
    const litMat = keep(new THREE.MeshBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.9}));
    const lit = new THREE.Mesh(ramLightGeo, litMat);
    lit.position.set(0, 0, 0.78);
    lit.scale.y = 0.02;                       // grows from the bottom as memory fills
    stick.add(lit);
    ramLights.push(lit);
  }

  // ---------------------------------------------------------------- graphics card
  const gpu = new THREE.Group();
  gpu.position.set(-1.2, -1.4, -D + 3.2);
  shell.add(gpu);
  const gpuBodyGeo = box(14, 2.8, 5.6);
  const gpuBody = mesh(gpuBodyGeo, matGpu, 0, 0, 0, "gpu");
  gpu.add(gpuBody);
  gpu.add(edgesOf(gpuBodyGeo, matEdge));
  const gpuFans = [makeFan(1.95, 9), makeFan(1.95, 9)];
  gpuFans.forEach((f, i) => {
    f.position.set(-3.4 + i * 6.8, 1.45, 0);
    f.rotation.x = -Math.PI / 2;               // lie flat: the fans face up, out of the open side
    gpu.add(f);
  });
  // VRAM strip along the card's front edge
  const vramMat = keep(new THREE.MeshBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.95}));
  const vram = new THREE.Mesh(box(12.4, 0.28, 0.14), vramMat);
  vram.position.set(0, -1.1, 2.85);
  vram.scale.x = 0.02;
  gpu.add(vram);
  const vramTrack = new THREE.Mesh(box(12.4, 0.28, 0.1),
    keep(new THREE.MeshBasicMaterial({color: "#1b2430", transparent: true, opacity: 0.85})));
  vramTrack.position.set(0, -1.1, 2.82);
  gpu.add(vramTrack);

  // ---------------------------------------------------------------- SSD + PSU
  const ssd = mesh(box(3.2, 0.34, 1.1), matMetal, 3.4, 0.2, -D + 1.1, "ssd");
  shell.add(ssd);
  const ssdLedMat = keep(new THREE.MeshBasicMaterial({color: ACCENT.clone(), transparent: true, opacity: 0.6}));
  const ssdLed = new THREE.Mesh(keep(new THREE.SphereGeometry(0.17, 12, 10)), ssdLedMat);
  ssdLed.position.set(1.35, 0.3, 0);
  ssd.add(ssdLed);

  const psu = new THREE.Group();
  psu.position.set(-5.4, -6.3, -D + 2.6);
  shell.add(psu);
  const psuGeo = box(8.4, 3.2, 5.2);
  psu.add(mesh(psuGeo, matDark, 0, 0, 0, "psu"));
  psu.add(edgesOf(psuGeo, matEdge));
  const psuFan = makeFan(1.35, 9);
  psuFan.position.set(0, 1.68, 0);
  psuFan.rotation.x = -Math.PI / 2;
  psu.add(psuFan);

  // rear exhaust fans
  const caseFans = [makeFan(1.75, 7), makeFan(1.75, 7)];
  caseFans.forEach((f, i) => {
    f.position.set(W - 2.2, 3.4 - i * 4.4, -D + 0.45);
    shell.add(f);
  });

  // ---------------------------------------------------------------- particle streams
  function makeStream(count, color, size) {
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = keep(new THREE.PointsMaterial({
      color: color.clone(), size, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true}));
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    return {pts, geo, mat, t: new Float32Array(count).map(() => Math.random()), count};
  }
  // PCIe: experts streaming from system memory down into the card
  const pcie = makeStream(90, ACCENT2, 0.3);
  const pcieMat = pcie.mat;
  // tokens: what the card hands back while the model writes
  const tokens = makeStream(70, ACCENT, 0.26);
  const tokenMat = tokens.mat;
  const A = new THREE.Vector3(1.6, 4.0, -D + 2.2);     // RAM
  const B = new THREE.Vector3(-3.0, 1.6, -D + 3.0);    // mid-board
  const C = new THREE.Vector3(-1.2, -0.6, -D + 3.2);   // the card

  // ---------------------------------------------------------------- state
  const live = {gpu: 0, temp: 0, vram: 0, cpu: 0, ram: 0, disk: 0, pcie: 0, power: 0, tok: 0, busy: 0};
  const target = {...live};
  let state = "idle";
  const data = {};                                      // last raw values, for the hover readout

  function update(m) {
    const hw = m.hardware || {}, l = m.live || {}, eng = m.engine || {};
    Object.assign(data, {hw, live: l, eng, st: m.hardware_static || {}});
    state = l.state || "idle";
    target.gpu = clamp01((hw.gpu_util || 0) / 100);
    target.temp = clamp01(((hw.gpu_temp || 0) - 30) / 55);          // 30 C idle .. 85 C hot
    target.vram = hw.gpu_mem_total ? clamp01(hw.gpu_mem_used / hw.gpu_mem_total) : 0;
    target.cpu = clamp01((hw.cpu || 0) / 100);
    target.ram = hw.ram_total ? clamp01(hw.ram_used / hw.ram_total) : 0;
    target.disk = clamp01((hw.disk_read_mb || 0) / 1200);
    target.pcie = clamp01((hw.gpu_pcie_rx_mb || 0) / 2500);
    target.power = hw.gpu_power_limit ? clamp01(hw.gpu_power / hw.gpu_power_limit) : clamp01((hw.gpu_power || 0) / 350);
    target.tok = clamp01((l.tok_s || 0) / 60);
    target.busy = state === "idle" ? 0 : 1;
  }

  /** what the hover readout shows for a part, from the newest telemetry */
  function partReadout(key) {
    const hw = data.hw || {}, st = data.st || {}, eng = data.eng || {};
    const n = (v, d = 0) => (v == null ? "–" : v.toFixed(d));
    const gb = (b) => (b == null ? "–" : (b / 1073741824).toFixed(1));
    switch (key) {
      case "gpu": return [st.gpu_name || "Graphics card",
        `${n(hw.gpu_util)}% · ${n(hw.gpu_temp)}°C · ${n(hw.gpu_power)} W · ${gb(hw.gpu_mem_used)}/${gb(hw.gpu_mem_total)} GB`];
      case "cpu": return ["Processor", `${n(hw.cpu)}%${st.threads ? ` · ${st.threads} threads` : ""}`];
      case "ram": return ["Memory", `${gb(hw.ram_used)} / ${gb(hw.ram_total)} GB`];
      case "ssd": return ["Storage", `read ${n(hw.disk_read_mb, 1)} MB/s · write ${n(hw.disk_write_mb, 1)} MB/s`];
      case "psu": return ["Power", `${n(hw.gpu_power)} W${hw.gpu_power_limit ? ` of ${n(hw.gpu_power_limit)} W` : ""}`];
      case "board": return ["Mainboard", hw.gpu_pcie_rx_mb == null ? "PCIe" : `PCIe to GPU ${n(hw.gpu_pcie_rx_mb, 1)} MB/s`];
      default: return [PARTS[key] || "", eng.max_context ? `context ${(eng.max_context / 1024).toFixed(0)}K` : ""];
    }
  }

  // ---------------------------------------------------------------- camera, drag to rotate
  const AZ0 = 0.46, EL0 = 0.30, RADIUS = 36;
  let az = AZ0, el = EL0, azTarget = az, elTarget = el, idleSpin = true, lastDrag = 0;
  let idleBaseAz = AZ0, idleBaseEl = EL0, driftT = 0;
  function placeCamera() {
    camera.position.set(Math.sin(az) * Math.cos(el) * RADIUS, Math.sin(el) * RADIUS + 1.5, Math.cos(az) * Math.cos(el) * RADIUS);
    camera.lookAt(0, 0.5, 0);
  }
  let dragging = false, px = 0, py = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; px = e.clientX; py = e.clientY; idleSpin = false; lastDrag = performance.now();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      azTarget -= (e.clientX - px) * 0.0065;
      elTarget = Math.max(-0.25, Math.min(0.85, elTarget + (e.clientY - py) * 0.004));
      px = e.clientX; py = e.clientY; lastDrag = performance.now();
      return;
    }
    hoverAt(e);
  });
  const endDrag = () => { dragging = false; canvas.style.cursor = "grab"; lastDrag = performance.now(); };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { hovered = null; onHover && onHover(null); });
  canvas.addEventListener("dblclick", () => {
    azTarget = idleBaseAz = AZ0; elTarget = idleBaseEl = EL0; driftT = 0; idleSpin = true;
  });
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "pan-y";          // let the page still scroll vertically over the canvas

  // ---------------------------------------------------------------- hover picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hovered = null, onHover = null;
  function hoverAt(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickable, false)[0];
    const key = hit ? hit.object.userData.part : null;
    if (key === hovered) return;
    hovered = key;
    onHover && onHover(key ? partReadout(key) : null);
  }

  // ---------------------------------------------------------------- frame loop
  const c1 = new THREE.Color(), c2 = new THREE.Color();
  let raf = 0, running = false, prev = 0, spinA = 0, spinB = 0, spinC = 0, spinD = 0, clock = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - prev) / 1000 || 0.016);
    prev = now;
    clock += dt;

    for (const k in target) live[k] = ease(live[k], target[k], 3.2, dt);

    // camera: a slow sway rather than a full orbit, so the open side keeps facing the viewer; a drag takes over, and
    // the sway resumes around wherever it was left
    if (!idleSpin && now - lastDrag > 9000) { idleSpin = true; idleBaseAz = azTarget; idleBaseEl = elTarget; driftT = 0; }
    if (idleSpin) {
      driftT += dt;
      azTarget = idleBaseAz + Math.sin(driftT * 0.16) * 0.40;
      elTarget = idleBaseEl + Math.sin(driftT * 0.11) * 0.06;
    }
    az = ease(az, azTarget, 5, dt);
    el = ease(el, elTarget, 5, dt);
    placeCamera();

    // fans: idle creep plus load
    spinA += dt * (0.5 + live.gpu * 13);
    spinB += dt * (0.5 + live.cpu * 10);
    spinC += dt * (0.4 + live.temp * 9);
    spinD += dt * (0.3 + live.power * 7);
    gpuFans.forEach((f) => { f.userData.spin.rotation.z = spinA; f.userData.ring.material.opacity = 0.18 + live.gpu * 0.5; });
    cpuFan.userData.spin.rotation.z = spinB;
    cpuFan.userData.ring.material.opacity = 0.15 + live.cpu * 0.45;
    caseFans.forEach((f, i) => { f.userData.spin.rotation.z = spinC * (i ? 0.92 : 1); f.userData.ring.material.opacity = 0.12 + live.temp * 0.4; });
    psuFan.userData.spin.rotation.z = spinD;
    psuFan.userData.ring.material.opacity = 0.1 + live.power * 0.35;

    // the card takes the heat of whatever is hotter: its load or its temperature
    const gpuHeat = Math.max(live.gpu, live.temp);
    heat(gpuHeat, c1);
    matGpu.emissive.copy(c1);
    matGpu.emissiveIntensity = 0.02 + gpuHeat * gpuHeat * 0.75;
    heat(live.cpu, c2);
    matCpu.emissive.copy(c2);
    matCpu.emissiveIntensity = 0.02 + live.cpu * live.cpu * 0.5;

    // VRAM strip and RAM sticks fill, and take a warning colour as they run out
    vram.scale.x = Math.max(0.02, live.vram);
    vram.position.x = -6.2 * (1 - live.vram);
    vramMat.color.copy(heat(live.vram * 0.9, c1));
    const ramFill = live.ram;
    ramLights.forEach((lit, i) => {
      const per = clamp01((ramFill - i * 0.25) * 4);        // the four sticks fill left to right
      lit.scale.y = Math.max(0.02, per);
      lit.position.y = -2.3 * (1 - per);
      lit.material.color.copy(heat(ramFill * 0.85, c2));
      lit.material.opacity = 0.35 + per * 0.6;
    });

    // SSD: a read LED that flickers faster the more the engine streams from disk
    const blink = live.disk > 0.002 ? 0.35 + 0.65 * Math.abs(Math.sin(clock * (4 + live.disk * 26))) : 0.12;
    ssdLedMat.opacity = blink;
    ssdLedMat.color.copy(live.disk > 0.3 ? WARM : ACCENT);

    // the face bar: breathing when idle, a quick pulse while writing, red when the card is hot
    const pulse = state === "generating" ? 0.55 + 0.45 * Math.sin(clock * (5 + live.tok * 9))
                : state === "reading" ? 0.45 + 0.4 * Math.sin(clock * 3.2)
                : 0.3 + 0.18 * Math.sin(clock * 1.1);
    faceBar.material.opacity = pulse;
    faceBar.material.color.copy(live.temp > 0.8 ? HOT : heat(live.busy ? 0.1 + live.gpu * 0.5 : 0, c1));
    powerLed.material.color.copy(faceBar.material.color);
    matEdge.opacity = 0.42 + live.busy * 0.3 + 0.06 * Math.sin(clock * 2);

    // streams
    stream(pcie, dt, 0.12 + live.pcie * 1.5, live.pcie > 0.004 ? 0.25 + live.pcie * 0.75 : 0, A, B, C);
    stream(tokens, dt, 0.25 + live.tok * 1.8, state === "generating" ? 0.35 + live.tok * 0.6 : 0, C, null, null);

    renderer.render(scene, camera);
  }

  const p = new THREE.Vector3();
  /** advance a stream; with three points it follows a bend, with one it sprays out of the open side */
  function stream(s, dt, speed, opacity, a, b, c) {
    s.mat.opacity = ease(s.mat.opacity, opacity, 4, dt);
    if (s.mat.opacity < 0.01) return;
    const pos = s.geo.attributes.position.array;
    for (let i = 0; i < s.count; i++) {
      s.t[i] += dt * speed * (0.6 + (i % 7) * 0.1);
      if (s.t[i] > 1) s.t[i] -= 1;
      const t = s.t[i];
      if (b) {
        // quadratic bend A -> B -> C, with a little per-particle spread
        const u = 1 - t;
        p.set(u * u * a.x + 2 * u * t * b.x + t * t * c.x,
              u * u * a.y + 2 * u * t * b.y + t * t * c.y,
              u * u * a.z + 2 * u * t * b.z + t * t * c.z);
        p.x += Math.sin(i * 2.3) * 0.5;
        p.z += Math.cos(i * 1.7) * 0.45;
      } else {
        // out of the card, towards the viewer, fanning as it goes
        p.set(a.x + Math.sin(i * 1.9) * 5.5 * t, a.y + t * 5 + Math.sin(i * 0.9) * 1.4 * t, a.z + t * 11);
      }
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    }
    s.geo.attributes.position.needsUpdate = true;
  }

  // ---------------------------------------------------------------- size, lifecycle
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  placeCamera();

  function setRunning(on) {
    if (on === running) return;
    running = on;
    if (on) { prev = performance.now(); resize(); raf = requestAnimationFrame(frame); }
    else { cancelAnimationFrame(raf); raf = 0; }
  }

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setRunning(false); });

  function dispose() {
    setRunning(false);
    ro.disconnect();
    themeWatch.disconnect();
    for (const d of disposables) d.dispose && d.dispose();
    scene.traverse((o) => { o.geometry && o.geometry.dispose(); });
    renderer.dispose();
  }

  return {
    update, setRunning, dispose, resize,
    onHover(fn) { onHover = fn; },
  };
}
