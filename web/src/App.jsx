// App.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import "jspdf-autotable";
import html2canvas from "html2canvas";
import * as pdfjsLib from "pdfjs-dist";

// pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.js`;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function money(n) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}
const mToFt = (m) => m * 3.280839895;

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Ground distance (meters) represented by one screen pixel at a given
// latitude/zoom - standard Web Mercator resolution formula, same math
// Mapbox itself uses to render tiles at true scale.
function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Pixel-based feet for “custom map” overlay mode
function customMapDistance(a, b, mapInstance) {
  if (!mapInstance) return 0;
  const pointA = mapInstance.project([a.lng, a.lat]);
  const pointB = mapInstance.project([b.lng, b.lat]);
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  const pixels = Math.sqrt(dx * dx + dy * dy);
  const pixelsPerFoot = 3.5; // calibration knob
  return pixels / pixelsPerFoot;
}

function best50_100(feet) {
  const L = Math.max(0, Number(feet || 0));

  if (L <= 50) return { n100: 0, n50: 1, total: 50, over: 50 - L, segs: 1 };
  if (L <= 100) return { n100: 1, n50: 0, total: 100, over: 100 - L, segs: 1 };

  const n100 = Math.floor(L / 100);
  const remainder = L - n100 * 100;
  const n50 = remainder > 0 ? (remainder <= 50 ? 1 : 2) : 0;
  const total = n100 * 100 + n50 * 50;
  const over = total - L;
  const segs = n100 + n50;
  return { n100, n50, total, over, segs };
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(hay, arr) {
  return arr.some((t) => hay.includes(t));
}

function detectLengthFt(name) {
  const n = norm(name);
  if (
    /\b50\s*(ft|feet|foot)\b/.test(n) ||
    /\b50ft\b/.test(n) ||
    n.includes("50'") ||
    /(^|[^0-9])50([^0-9]|$)/.test(n)
  )
    return 50;

  if (
    /\b100\s*(ft|feet|foot)\b/.test(n) ||
    /\b100ft\b/.test(n) ||
    n.includes("100'") ||
    /(^|[^0-9])100([^0-9]|$)/.test(n)
  )
    return 100;

  return null;
}

function detectCableBucket(name) {
  const n = norm(name);

  if (hasAny(n, ["spider box cable"])) return "50A";
  if (hasAny(n, ["2/5", "2-5", "2 5", "banded", "socapex", "5 wire", "5-wire"])) return "BANDED";
  if (hasAny(n, ["4/0", "4-0", "4 0", "feeder"])) return "FOUR_O";
  if (hasAny(n, ["quad stringer", "quad", "stringer", "stinger"])) return "QUAD";
  if (hasAny(n, ["30a extension", "extension"])) return "30A";

  return null;
}

function looksLikeCableRow(name) {
  const n = norm(name);
  if (n.includes("spider box") && !n.includes("cable")) return false;
  return hasAny(n, ["cable", "extension", "stinger", "stringer", "quad", "banded", "socapex", "4/0", "2/5", "feeder"]);
}

function extractSize(name, type) {
  const n = norm(name);

  if (type === "Gens") {
    const match = n.match(/(\d+)\s*kw/);
    return match ? match[1] : "";
  }

  if (type === "AC") {
    const match = n.match(/(\d+)\s*ton/);
    return match ? match[1] : "";
  }

  if (type === "Distro") {
    const ampMatch = n.match(/(\d+)\s*a/);
    if (ampMatch) return ampMatch[1] + "A";
    if (n.includes("spider")) return "SB";
    if (n.includes("quad")) return "QB";
    if (n.includes("cam")) return "CM";
    return "D";
  }

  return "";
}

// ──────────────────────────────────────────────────────────────────────────────
// Equipment marker creation (NOT Mapbox Marker)
// These are rendered into an absolute overlay that is attached to map.getContainer()
// so it does NOT inherit Mapbox canvas smooth-zoom transform scaling.
// ──────────────────────────────────────────────────────────────────────────────
function makeEquipmentMarkerEl(it) {
  const gp = it?.gp || "";
  const name = it?.name || "";
  const size = extractSize(name, gp);

  const root = document.createElement("div");
  root.style.position = "absolute";
  root.style.transform = "translate(-50%, -50%)";
  root.style.cursor = "pointer";
  root.style.userSelect = "none";
  root.style.pointerEvents = "auto";
  root.style.willChange = "left, top";
  root.title = `${gp}: ${name}\nShift+Drag to move | Right-click to delete`;

  const col = document.createElement("div");
  col.style.display = "flex";
  col.style.flexDirection = "column";
  col.style.alignItems = "center";
  col.style.gap = "2px";

  const shape = document.createElement("div");
  shape.style.display = "grid";
  shape.style.placeItems = "center";
  shape.style.border = "2px solid #111";
  shape.style.boxShadow = "0 2px 10px rgba(0,0,0,0.35)";
  shape.style.fontWeight = "900";
  shape.style.fontSize = "10px";
  shape.style.color = "#fff";
  shape.style.textShadow = "0 1px 2px rgba(0,0,0,0.5)";
  shape.style.pointerEvents = "auto";
  shape.style.boxSizing = "border-box";
  // Width/height below are the icon's size *before* real-world scaling is
  // applied by the render loop (see EQUIP_REAL_METERS / metersPerPixel) -
  // baseWidthPx records that starting size so the scale factor can be
  // computed relative to it.
  shape.style.transformOrigin = "center center";

  let baseWidthPx;
  if (gp === "Gens") {
    baseWidthPx = 36;
    shape.style.width = "36px";
    shape.style.height = "36px";
    shape.style.background = "#00c853";
    shape.style.borderRadius = "4px";
    shape.style.fontSize = "9px";
    shape.textContent = size ? `${size}kW` : "G";
  } else if (gp === "AC") {
    baseWidthPx = 36;
    shape.style.width = "36px";
    shape.style.height = "32px";
    shape.style.background = "#2196f3";
    shape.style.clipPath = "polygon(50% 0%, 0% 100%, 100% 100%)";
    shape.style.border = "none";
    shape.style.fontSize = "9px";
    shape.textContent = size ? `${size}T` : "AC";
    shape.style.paddingTop = "12px";
  } else if (gp === "Distro") {
    baseWidthPx = 30;
    shape.style.width = "30px";
    shape.style.height = "30px";
    shape.style.background = "#ffd600";
    shape.style.borderRadius = "4px";
    shape.style.color = "#111";
    shape.style.textShadow = "none";
    shape.style.fontSize = "8px";
    shape.textContent = size || "D";
  } else {
    baseWidthPx = 22;
    shape.style.width = "22px";
    shape.style.height = "22px";
    shape.style.borderRadius = "50%";
    shape.style.background = "#9e9e9e";
    shape.textContent = "?";
  }

  col.appendChild(shape);

  const del = document.createElement("div");
  del.textContent = "×";
  del.style.cssText = `
    position:absolute;
    top:-8px;
    right:-8px;
    width:18px;
    height:18px;
    background:#d32f2f;
    color:#fff;
    border-radius:50%;
    display:none;
    align-items:center;
    justify-content:center;
    font-size:14px;
    font-weight:900;
    cursor:pointer;
    z-index:1000;
    border:2px solid #fff;
    box-shadow:0 2px 4px rgba(0,0,0,0.3);
  `;

  root.appendChild(col);
  root.appendChild(del);

  root.addEventListener("mouseenter", () => (del.style.display = "flex"));
  root.addEventListener("mouseleave", () => (del.style.display = "none"));

  return { root, del, shape, baseWidthPx };
}

// Approximate real-world footprint (meters) each equipment type occupies on
// the ground - roughly a parking-space-sized pad for the larger gear, a bit
// less for smaller items. This is what equipment size is actually scaled
// against (via metersPerPixel), not an arbitrary on-screen pixel guess.
const EQUIP_SIZE_MULTIPLIER = 1.15;
function equipRealMeters(gp) {
  const base = gp === "Gens" ? 3 : gp === "AC" ? 2.5 : gp === "Distro" ? 1.5 : 1.5;
  return base * EQUIP_SIZE_MULTIPLIER;
}

// Safety bounds only - the real scale comes from metersPerPixel(). These
// just stop an icon from vanishing or covering the screen at extreme zoom.
const EQUIP_MIN_SCALE = 0.05;
const EQUIP_MAX_SCALE = 6;
// True-to-scale math can shrink an icon well below what's actually usable
// at normal working zoom - never render smaller than this floor, even if
// the geometrically "correct" size would be tinier. Still shrinks naturally
// with zoom above the floor, and still grows accurately zooming in. Gens/AC
// need a bigger floor than Distro to stay readable.
function equipMinVisiblePx(gp) {
  if (gp === "Gens" || gp === "AC") return 40;
  return 20;
}

function equipScaleForRealMeters(gp, realMeters, mpp, baseWidthPx) {
  const targetPx = Math.max(equipMinVisiblePx(gp), realMeters / mpp);
  return Math.min(EQUIP_MAX_SCALE, Math.max(EQUIP_MIN_SCALE, targetPx / baseWidthPx));
}

export default function App() {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);

  // Equipment overlay + nodes
  const equipOverlayRef = useRef(null);
  const equipNodesRef = useRef(new Map()); // id -> { el, it, lng, lat }
  // Read inside the map-init effect (which only runs once, on [showHomePage])
  // so it sees the latest customMapMode without needing to reinit the map.
  const customMapModeRef = useRef(false);

  // Cables
  const cableSourceId = "g2g-cables";
  const cableLayerId = "g2g-cables-layer";
  const cableOverlayRef = useRef(null);
  const outletNodesRef = useRef(new Map());
  const quadCenterNodesRef = useRef(new Map());
  const cableLabelNodesRef = useRef(new Map());

  // State
  const [showHomePage, setShowHomePage] = useState(true);

  const [catalog, setCatalog] = useState([]);
  const [billingTerm, setBillingTerm] = useState("day");

  const [placed, setPlaced] = useState([]);
  const [cables, setCables] = useState([]);

  const [showEquipment, setShowEquipment] = useState(false);
  const [showBom, setShowBom] = useState(false);

  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");

  const [tool, setTool] = useState("select");
  const [cableType, setCableType] = useState("50A");
  const [cableDraftStart, setCableDraftStart] = useState(null);
  const [cableDraftEnd, setCableDraftEnd] = useState(null);

  const [customMapImage, setCustomMapImage] = useState(null);
  const [customMapBounds, setCustomMapBounds] = useState(null);
  const [customMapMode, setCustomMapMode] = useState(false);
  useEffect(() => {
    customMapModeRef.current = customMapMode;
  }, [customMapMode]);

  // Manual equipment size adjustment (1 = 100%), on top of whatever the
  // real-scale/floor math computes. User-controlled via +/- buttons since
  // no single hardcoded value reads right for everyone.
  const [equipSizeAdjust, setEquipSizeAdjust] = useState(() => {
    const saved = Number(localStorage.getItem("g2g-equip-size-adjust"));
    return saved > 0 ? saved : 1;
  });
  const equipSizeAdjustRef = useRef(equipSizeAdjust);
  useEffect(() => {
    equipSizeAdjustRef.current = equipSizeAdjust;
    localStorage.setItem("g2g-equip-size-adjust", String(equipSizeAdjust));
    // Force a repaint so already-placed equipment picks up the new size
    // immediately, not just the next time the map itself moves.
    mapRef.current?.triggerRepaint();
  }, [equipSizeAdjust]);

  const uiPanelStyle = {
    background: "rgba(255,255,255,0.94)",
    border: "1px solid rgba(0,0,0,0.15)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
    color: "#111",
  };

  const baseBtn = {
    background: "#111",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 900,
    cursor: "pointer",
  };

  const lightBtn = {
    background: "#fff",
    color: "#111",
    border: "1px solid rgba(0,0,0,0.18)",
    borderRadius: 12,
    padding: "10px 14px",
    fontWeight: 900,
    cursor: "pointer",
  };

  function rateFor(it) {
    if (billingTerm === "day") return Number(it.day || 0);
    if (billingTerm === "week") return Number(it.week || 0);
    return Number(it.month || 0);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Map init
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (showHomePage) return;

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) {
      console.error("Missing VITE_MAPBOX_TOKEN in .env.local");
      return;
    }
    if (!mapDivRef.current) return;

    mapboxgl.accessToken = token;

    const m = new mapboxgl.Map({
      container: mapDivRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-90.1994, 38.627],
      zoom: 14,
      preserveDrawingBuffer: true,
    });

    m.addControl(new mapboxgl.NavigationControl({ showCompass: true, showZoom: true }), "top-right");

    const updateAllOverlayScreenPositions = () => {
      // Uploaded PDF/image maps are draped over made-up lng/lat bounds, not
      // real geography, so ground-resolution math is meaningless there -
      // fall back to a fixed on-screen size, same idea as the fixed
      // pixelsPerFoot calibration cable lengths already use in this mode.
      const useRealScale = !customMapModeRef.current;
      const mpp = useRealScale ? metersPerPixel(m.getCenter().lat, m.getZoom()) : null;
      for (const node of equipNodesRef.current.values()) {
        const p = m.project([node.lng, node.lat]);
        node.el.style.left = `${p.x}px`;
        node.el.style.top = `${p.y}px`;
        const baseScale = useRealScale
          ? equipScaleForRealMeters(node.it?.gp, node.realMeters, mpp, node.baseWidthPx)
          : EQUIP_SIZE_MULTIPLIER;
        node.shape.style.transform = `scale(${baseScale * equipSizeAdjustRef.current})`;
      }
      for (const node of cableLabelNodesRef.current.values()) {
        const p = m.project([node.lng, node.lat]);
        node.el.style.left = `${p.x}px`;
        node.el.style.top = `${p.y}px`;
      }
      for (const node of quadCenterNodesRef.current.values()) {
        const p = m.project([node.lng, node.lat]);
        node.el.style.left = `${p.x}px`;
        node.el.style.top = `${p.y}px`;
      }
      for (const node of outletNodesRef.current.values()) {
        const p = m.project([node.lng, node.lat]);
        node.el.style.left = `${p.x}px`;
        node.el.style.top = `${p.y}px`;
      }
    };

    m.on("load", () => {
      // Cable source/layer
      if (!m.getSource(cableSourceId)) {
        m.addSource(cableSourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!m.getLayer(cableLayerId)) {
        m.addLayer({
          id: cableLayerId,
          type: "line",
          source: cableSourceId,
          paint: {
            "line-width": 4,
            "line-opacity": 0.9,
            "line-color": [
              "match",
              ["get", "type"],
              "50A",
              "#00c853",
              "30A",
              "#2962ff",
              "BANDED",
              "#ff6d00",
              "FOUR_O",
              "#d50000",
              "QUAD",
              "#6a1b9a",
              "#00c853",
            ],
          },
          layout: { "line-cap": "round", "line-join": "round" },
        });
      }

      // ✅ CRITICAL: attach overlays to map.getContainer(), NOT canvasContainer.
      // The canvasContainer is what Mapbox scales during scroll-zoom animation
      // (that's the "markers grow/shrink while zooming" bug) — mapboxgl.Marker
      // elements live inside that scaled container, so both equipment AND cable
      // markers (labels, quad handle, quad outlets) must live outside it here.
      const container = m.getContainer(); // not scaled during smooth zoom

      const cableOverlay = document.createElement("div");
      cableOverlay.style.position = "absolute";
      cableOverlay.style.inset = "0";
      cableOverlay.style.pointerEvents = "none";
      cableOverlay.style.zIndex = "25";
      cableOverlay.style.transform = "none";
      cableOverlay.style.willChange = "auto";
      container.appendChild(cableOverlay);
      cableOverlayRef.current = cableOverlay;

      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "30";
      overlay.style.transform = "none"; // paranoia: never inherit transforms
      overlay.style.willChange = "auto";
      container.appendChild(overlay);
      equipOverlayRef.current = overlay;

      requestAnimationFrame(updateAllOverlayScreenPositions);
    });

    // Reposition equipment + cable overlays on any render tick (covers smooth zoom frames)
    m.on("render", updateAllOverlayScreenPositions);

    mapRef.current = m;

    // keyboard rotate quickies
    m.keyboard.enable();
    m.getCanvas().addEventListener("keydown", (e) => {
      if (e.shiftKey && e.key === "ArrowLeft") m.setBearing(m.getBearing() - 15);
      else if (e.shiftKey && e.key === "ArrowRight") m.setBearing(m.getBearing() + 15);
      else if (e.key === "r" || e.key === "R") m.resetNorth();
    });

    setTimeout(() => m.resize(), 0);

    return () => {
      // equipment overlay cleanup
      for (const node of equipNodesRef.current.values()) node.el.remove();
      equipNodesRef.current.clear();
      equipOverlayRef.current?.remove?.();
      equipOverlayRef.current = null;

      // cable overlay cleanup
      for (const node of outletNodesRef.current.values()) node.el.remove();
      outletNodesRef.current.clear();
      for (const node of quadCenterNodesRef.current.values()) node.el.remove();
      quadCenterNodesRef.current.clear();
      for (const node of cableLabelNodesRef.current.values()) node.el.remove();
      cableLabelNodesRef.current.clear();
      cableOverlayRef.current?.remove?.();
      cableOverlayRef.current = null;

      m.off("render", updateAllOverlayScreenPositions);

      m.remove();
    };
  }, [showHomePage]);

  // ────────────────────────────────────────────────────────────────────────────
  // Catalog CSV load
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/catalog.csv`)
      .then((r) => {
        if (!r.ok) throw new Error(`catalog.csv HTTP ${r.status}`);
        return r.text();
      })
      .then((csv) => {
        const parsed = Papa.parse(csv, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
        });

        const rows = (parsed.data || [])
          .map((r) => ({
            gp: String(r["GP"] ?? "").trim(),
            name: String(r["Equipment Name"] ?? "").trim(),
            day: Number(String(r["Daily"] ?? "0").replace(/[$,]/g, "")) || 0,
            week: Number(String(r["Weekly"] ?? "0").replace(/[$,]/g, "")) || 0,
            month: Number(String(r["Monthly"] ?? "0").replace(/[$,]/g, "")) || 0,
          }))
          .filter((x) => x.gp && x.name);

        setCatalog(rows);
      })
      .catch((e) => {
        console.error("Failed loading /data/catalog.csv", e);
        setCatalog([]);
      });
  }, []);

  // ────────────────────────────────────────────────────────────────────────────
  // Cable index from catalog
  // ────────────────────────────────────────────────────────────────────────────
  const cableIndex = useMemo(() => {
    const idx = {
      "50": { "50A": [], "30A": [], BANDED: [], FOUR_O: [], QUAD: [] },
      "100": { "50A": [], "30A": [], BANDED: [], FOUR_O: [], QUAD: [] },
    };

    for (const it of catalog) {
      const n = norm(it.name);
      if (!looksLikeCableRow(n)) continue;
      const len = detectLengthFt(n);
      const bucket = detectCableBucket(n);
      if (!len || !bucket) continue;
      idx[String(len)][bucket].push(it);
    }

    for (const len of ["50", "100"]) {
      for (const b of ["50A", "30A", "BANDED", "FOUR_O", "QUAD"]) {
        idx[len][b].sort((a, c) => a.name.localeCompare(c.name));
      }
    }

    return idx;
  }, [catalog]);

  function findCableItemStrict(bucket, len) {
    const list = cableIndex[String(len)]?.[bucket] || [];
    return list[0] || null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Equipment groups (exclude Cable)
  // ────────────────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of catalog) {
      if (it.gp === "Cable") continue;
      if (!m.has(it.gp)) m.set(it.gp, []);
      m.get(it.gp).push(it);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  // ────────────────────────────────────────────────────────────────────────────
  // Place equipment (NO scaling on scroll zoom)
  // ────────────────────────────────────────────────────────────────────────────
  function placeEquipmentAt(it, lng, lat, forcedId) {
    const m = mapRef.current;
    if (!m) return;
    const overlay = equipOverlayRef.current;
    if (!overlay) return;

    const id = forcedId || crypto.randomUUID();

    const existing = equipNodesRef.current.get(id);
    if (existing) {
      existing.el.remove();
      equipNodesRef.current.delete(id);
    }

    const { root, del, shape, baseWidthPx } = makeEquipmentMarkerEl(it);
    const realMeters = equipRealMeters(it?.gp || "");

    const removePlaced = (rid) => {
      const node = equipNodesRef.current.get(rid);
      if (node) {
        node.el.remove();
        equipNodesRef.current.delete(rid);
      }
      setPlaced((prev) => prev.filter((x) => x.id !== rid));
    };

    del.onclick = (e) => {
      e.stopPropagation();
      removePlaced(id);
    };

    root.oncontextmenu = (e) => {
      e.preventDefault();
      if (confirm("Delete this equipment?")) removePlaced(id);
    };

    // shift+drag move
    let dragging = false;
    const onMouseMove = (ev) => {
      if (!dragging) return;
      const rect = mapDivRef.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const ll = m.unproject([x, y]);
      const node = equipNodesRef.current.get(id);
      if (!node) return;

      node.lng = ll.lng;
      node.lat = ll.lat;

      setPlaced((prev) => prev.map((p) => (p.id === id ? { ...p, lng: ll.lng, lat: ll.lat } : p)));

      const pt = m.project([ll.lng, ll.lat]);
      root.style.left = `${pt.x}px`;
      root.style.top = `${pt.y}px`;
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      root.style.cursor = "pointer";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    root.addEventListener("mousedown", (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      root.style.cursor = "grabbing";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    overlay.appendChild(root);
    equipNodesRef.current.set(id, { el: root, shape, baseWidthPx, realMeters, it, lng, lat });

    const p = m.project([lng, lat]);
    root.style.left = `${p.x}px`;
    root.style.top = `${p.y}px`;
    const baseInitialScale = customMapModeRef.current
      ? EQUIP_SIZE_MULTIPLIER
      : equipScaleForRealMeters(it?.gp, realMeters, metersPerPixel(lat, m.getZoom()), baseWidthPx);
    shape.style.transform = `scale(${baseInitialScale * equipSizeAdjustRef.current})`;

    setPlaced((prev) => {
      const exists = prev.some((x) => x.id === id);
      if (exists) return prev.map((x) => (x.id === id ? { id, ...it, lng, lat } : x));
      return [...prev, { id, ...it, lng, lat }];
    });
  }

  function addItem(it) {
    const m = mapRef.current;
    if (!m) return;
    const c = m.getCenter();
    placeEquipmentAt(it, c.lng, c.lat);
  }

  function handleMapDrop(e) {
    e.preventDefault();
    const m = mapRef.current;
    if (!m) return;

    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;

    let it;
    try {
      it = JSON.parse(raw);
    } catch {
      return;
    }

    const rect = mapDivRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ll = m.unproject([x, y]);
    placeEquipmentAt(it, ll.lng, ll.lat);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Cable tool input
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;

    function onMouseMove(e) {
      if (tool !== "cable") return;
      if (cableType === "QUAD") return;
      if (!cableDraftStart) return;
      setCableDraftEnd({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    }

    function onClick(e) {
      if (tool !== "cable") return;

      const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };

      if (cableType === "QUAD") {
        const id = crypto.randomUUID();

        let a, b;
        if (customMapMode && m) {
          const pixelsFor50ft = 175;
          const centerPixel = m.project([p.lng, p.lat]);
          const leftPixel = { x: centerPixel.x - pixelsFor50ft / 2, y: centerPixel.y };
          const rightPixel = { x: centerPixel.x + pixelsFor50ft / 2, y: centerPixel.y };
          const leftCoord = m.unproject(leftPixel);
          const rightCoord = m.unproject(rightPixel);
          a = { lng: leftCoord.lng, lat: leftCoord.lat };
          b = { lng: rightCoord.lng, lat: rightCoord.lat };
        } else {
          const offsetLng = 0.00015;
          a = { lng: p.lng - offsetLng / 2, lat: p.lat };
          b = { lng: p.lng + offsetLng / 2, lat: p.lat };
        }

        setCables((prev) => [...prev, { id, type: cableType, a, b, feet: 50, rotation: 0 }]);
        return;
      }

      if (!cableDraftStart) {
        setCableDraftStart(p);
        setCableDraftEnd(p);
        return;
      }

      const a = cableDraftStart;
      const b = p;
      const feet = customMapMode ? customMapDistance(a, b, m) : mToFt(haversineMeters(a, b));
      const id = crypto.randomUUID();
      setCables((prev) => [...prev, { id, type: cableType, a, b, feet }]);
      setCableDraftStart(null);
      setCableDraftEnd(null);
    }

    function onContextMenu(e) {
      // Ctrl+Shift+Right Click = delete cable run under mouse
      if (e.originalEvent.ctrlKey && e.originalEvent.shiftKey) {
        e.preventDefault();
        const features = m.queryRenderedFeatures(e.point, { layers: [cableLayerId] });
        if (features.length > 0) {
          const cableId = features[0].properties.id;
          if (cableId && cableId !== "draft") {
            if (confirm("Delete this cable run?")) {
              setCables((prev) => prev.filter((c) => c.id !== cableId));
            }
          }
        }
      }
    }

    m.on("mousemove", onMouseMove);
    m.on("click", onClick);
    m.on("contextmenu", onContextMenu);

    return () => {
      m.off("mousemove", onMouseMove);
      m.off("click", onClick);
      m.off("contextmenu", onContextMenu);
    };
  }, [tool, cableType, cableDraftStart, customMapMode]);

  function clearCableDraft() {
    setCableDraftStart(null);
    setCableDraftEnd(null);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Update cable geojson + markers
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const src = m.getSource(cableSourceId);
    if (!src) return;
    const overlay = cableOverlayRef.current;
    if (!overlay) return;

    const features = [];

    // clear old nodes
    for (const node of outletNodesRef.current.values()) node.el.remove();
    outletNodesRef.current.clear();
    for (const node of quadCenterNodesRef.current.values()) node.el.remove();
    quadCenterNodesRef.current.clear();
    for (const node of cableLabelNodesRef.current.values()) node.el.remove();
    cableLabelNodesRef.current.clear();

    // Places a DOM node on the cable overlay (outside Mapbox's scaled canvas
    // container) and records it so the render-tick loop keeps it positioned.
    const place = (el, lng, lat, nodeMap, key) => {
      overlay.appendChild(el);
      const p = m.project([lng, lat]);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      nodeMap.set(key, { el, lng, lat });
    };

    for (const c of cables) {
      features.push({
        type: "Feature",
        properties: { id: c.id, kind: "cable", feet: c.feet, type: c.type },
        geometry: {
          type: "LineString",
          coordinates: [
            [c.a.lng, c.a.lat],
            [c.b.lng, c.b.lat],
          ],
        },
      });

      const midLng = (c.a.lng + c.b.lng) / 2;
      const midLat = (c.a.lat + c.b.lat) / 2;

      const labelEl = document.createElement("div");
      labelEl.style.position = "absolute";
      labelEl.style.transform = "translate(-50%, -50%)";
      labelEl.style.pointerEvents = "none";
      labelEl.style.background = "rgba(255, 255, 255, 0.95)";
      labelEl.style.border = "2px solid #111";
      labelEl.style.borderRadius = "4px";
      labelEl.style.padding = "2px 6px";
      labelEl.style.fontSize = "11px";
      labelEl.style.fontWeight = "900";
      labelEl.style.color = "#111";
      labelEl.style.boxShadow = "0 2px 6px rgba(0,0,0,0.3)";
      labelEl.style.whiteSpace = "nowrap";
      labelEl.textContent = `${Math.round(c.feet)}'`;
      labelEl.title = `${c.feet.toFixed(1)} feet`;

      place(labelEl, midLng, midLat, cableLabelNodesRef.current, `${c.id}-label`);

      if (c.type === "QUAD") {
        const centerLng = (c.a.lng + c.b.lng) / 2;
        const centerLat = (c.a.lat + c.b.lat) / 2;
        const rotation = c.rotation || 0;

        const centerEl = document.createElement("div");
        centerEl.style.position = "absolute";
        centerEl.style.transform = "translate(-50%, -50%)";
        centerEl.style.pointerEvents = "auto";
        centerEl.style.width = "20px";
        centerEl.style.height = "20px";
        centerEl.style.background = "#6a1b9a";
        centerEl.style.border = "2px solid #fff";
        centerEl.style.borderRadius = "50%";
        centerEl.style.boxShadow = "0 2px 8px rgba(0,0,0,0.5)";
        centerEl.style.cursor = "grab";
        centerEl.style.display = "grid";
        centerEl.style.placeItems = "center";
        centerEl.style.color = "#fff";
        centerEl.style.fontSize = "8px";
        centerEl.style.fontWeight = "900";
        centerEl.textContent = "Q";
        centerEl.title = "Drag to rotate | Shift+Drag to move";

        // No mapboxgl.Marker here (same reason as equipment): dragging is
        // handled by hand via project()/unproject() so this node never rides
        // Mapbox's scaled canvas container.
        centerEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const isMove = e.shiftKey;
          centerEl.style.cursor = isMove ? "grabbing" : "crosshair";

          const rect0 = mapDivRef.current.getBoundingClientRect();
          const startCenterPx = m.project([centerLng, centerLat]);
          const startAngle =
            Math.atan2(
              e.clientY - (rect0.top + startCenterPx.y),
              e.clientX - (rect0.left + startCenterPx.x)
            ) *
            (180 / Math.PI);
          const rotateStartAngle = startAngle - rotation;

          const onMouseMove = (moveEvent) => {
            const rect = mapDivRef.current.getBoundingClientRect();

            if (isMove) {
              const x = moveEvent.clientX - rect.left;
              const y = moveEvent.clientY - rect.top;
              const ll = m.unproject([x, y]);
              const offsetLng = 0.00015;
              const radians = (rotation * Math.PI) / 180;
              const dx = (offsetLng / 2) * Math.cos(radians);
              const dy = (offsetLng / 2) * Math.sin(radians);

              setCables((prev) =>
                prev.map((cable) =>
                  cable.id === c.id
                    ? { ...cable, a: { lng: ll.lng - dx, lat: ll.lat - dy }, b: { lng: ll.lng + dx, lat: ll.lat + dy } }
                    : cable
                )
              );
            } else {
              const centerPx = m.project([centerLng, centerLat]);
              const cx = rect.left + centerPx.x;
              const cy = rect.top + centerPx.y;
              const currentAngle = Math.atan2(moveEvent.clientY - cy, moveEvent.clientX - cx) * (180 / Math.PI);
              const newRotation = currentAngle - rotateStartAngle;

              const offsetLng = 0.00015;
              const radians = (newRotation * Math.PI) / 180;
              const dx = (offsetLng / 2) * Math.cos(radians);
              const dy = (offsetLng / 2) * Math.sin(radians);

              setCables((prev) =>
                prev.map((cable) =>
                  cable.id === c.id
                    ? {
                        ...cable,
                        a: { lng: centerLng - dx, lat: centerLat - dy },
                        b: { lng: centerLng + dx, lat: centerLat + dy },
                        rotation: newRotation,
                      }
                    : cable
                )
              );
            }
          };

          const onMouseUp = () => {
            centerEl.style.cursor = "grab";
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
          };

          document.addEventListener("mousemove", onMouseMove);
          document.addEventListener("mouseup", onMouseUp);
        });

        place(centerEl, centerLng, centerLat, quadCenterNodesRef.current, c.id);

        for (let outlet = 1; outlet <= 3; outlet++) {
          const progress = outlet / 4;
          const lng = c.a.lng + (c.b.lng - c.a.lng) * progress;
          const lat = c.a.lat + (c.b.lat - c.a.lat) * progress;

          const outletEl = document.createElement("div");
          outletEl.style.position = "absolute";
          outletEl.style.transform = "translate(-50%, -50%)";
          outletEl.style.pointerEvents = "none";
          outletEl.style.width = "12px";
          outletEl.style.height = "12px";
          outletEl.style.background = "#fff";
          outletEl.style.border = "2px solid #6a1b9a";
          outletEl.style.borderRadius = "2px";
          outletEl.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
          outletEl.title = `Quad Outlet ${outlet}`;

          place(outletEl, lng, lat, outletNodesRef.current, `${c.id}-outlet-${outlet}`);
        }
      }
    }

    if (tool === "cable" && cableDraftStart && cableDraftEnd) {
      features.push({
        type: "Feature",
        properties: { id: "draft", kind: "draft", type: cableType },
        geometry: {
          type: "LineString",
          coordinates: [
            [cableDraftStart.lng, cableDraftStart.lat],
            [cableDraftEnd.lng, cableDraftEnd.lat],
          ],
        },
      });
    }

    src.setData({ type: "FeatureCollection", features });
  }, [cables, tool, cableDraftStart, cableDraftEnd, cableType]);

  const draftFeet = useMemo(() => {
    const m = mapRef.current;
    if (!m) return 0;
    if (!cableDraftStart || !cableDraftEnd) return 0;
    return customMapMode ? customMapDistance(cableDraftStart, cableDraftEnd, m) : mToFt(haversineMeters(cableDraftStart, cableDraftEnd));
  }, [cableDraftStart, cableDraftEnd, customMapMode]);

  // ────────────────────────────────────────────────────────────────────────────
  // BOM
  // ────────────────────────────────────────────────────────────────────────────
  const equipmentBom = useMemo(() => {
    const qty = new Map();
    const sample = new Map();
    for (const p of placed) {
      const k = `${p.gp}::${p.name}`;
      qty.set(k, (qty.get(k) || 0) + 1);
      if (!sample.has(k)) sample.set(k, p);
    }

    const rows = [];
    for (const [k, q] of qty.entries()) {
      const it = sample.get(k);
      const rate = rateFor(it);
      rows.push({ kind: "equipment", gp: it.gp, name: it.name, qty: q, rate, subtotal: q * rate });
    }
    rows.sort((a, b) => (a.gp + a.name).localeCompare(b.gp + b.name));
    return rows;
  }, [placed, billingTerm]);

  const equipmentTotal = equipmentBom.reduce((s, r) => s + r.subtotal, 0);

  const cableBom = useMemo(() => {
    const qty = new Map();
    const sample = new Map();

    for (const run of cables) {
      const combo = best50_100(run.feet);

      // Cable types that are only stocked in 50ft lengths - a 100ft run means
      // pricing two 50ft cables (doubled), not a real 100ft catalog item.
      // 30A and 50A are genuinely stocked in both lengths with their own
      // 100ft pricing, so they use the real catalog lookup below instead.
      const is50ftOnly = run.type === "FOUR_O" || run.type === "QUAD" || run.type === "BANDED";

      let segments;
      if (is50ftOnly) {
        segments = [];
        if (combo.n100 > 0) segments.push({ len: 100, qty: combo.n100, is_calculated: true });
        if (combo.n50 > 0) segments.push({ len: 50, qty: combo.n50, is_calculated: false });
      } else {
        segments = [
          { len: 100, qty: combo.n100, is_calculated: false },
          { len: 50, qty: combo.n50, is_calculated: false },
        ].filter((x) => x.qty > 0);
      }

      for (const seg of segments) {
        let name, catalogItem, is_calculated;

        if (seg.is_calculated) {
          const matched50 = findCableItemStrict(run.type, 50);
          if (matched50) {
            name = matched50.name.replace(/50\s*ft|50ft|50'/i, "100ft");
            catalogItem = matched50;
            is_calculated = true;
          } else {
            name = `${run.type} ${seg.len}ft (NO CATALOG MATCH)`;
            catalogItem = null;
            is_calculated = false;
          }
        } else {
          catalogItem = findCableItemStrict(run.type, seg.len);
          name = catalogItem ? catalogItem.name : `${run.type} ${seg.len}ft (NO CATALOG MATCH)`;
          is_calculated = false;
        }

        const gp = "Cable";
        const k = `${run.type}|${seg.len}|${gp}::${name}`;
        qty.set(k, (qty.get(k) || 0) + seg.qty);
        if (!sample.has(k)) sample.set(k, { gp, name, catalogItem, is_calculated, matched: !!catalogItem });
      }
    }

    const rows = [];
    for (const [k, q] of qty.entries()) {
      const it = sample.get(k);
      const rate = it.catalogItem ? (it.is_calculated ? rateFor(it.catalogItem) * 2 : rateFor(it.catalogItem)) : 0;
      rows.push({
        kind: "cable",
        gp: it.gp,
        name: it.name,
        qty: q,
        rate,
        subtotal: q * rate,
        matched: it.matched,
      });
    }
    rows.sort((a, b) => (a.gp + a.name).localeCompare(b.gp + b.name));
    return rows;
  }, [cables, billingTerm, cableIndex]);

  const cableTotal = cableBom.reduce((s, r) => s + r.subtotal, 0);
  const total = equipmentTotal + cableTotal;
  const totalCableFeet = useMemo(() => cables.reduce((s, c) => s + (c.feet || 0), 0), [cables]);

  // ────────────────────────────────────────────────────────────────────────────
  // Address search
  // ────────────────────────────────────────────────────────────────────────────
  async function runSearch() {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    const m = mapRef.current;
    if (!token || !m) return;

    const query = q.trim();
    if (!query) return;

    setSearchErr("");
    setSearching(true);

    try {
      const url =
        "https://api.mapbox.com/geocoding/v5/mapbox.places/" +
        encodeURIComponent(query) +
        ".json?limit=1&access_token=" +
        encodeURIComponent(token);

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
      const data = await res.json();

      const f = data?.features?.[0];
      if (!f) {
        setSearchErr("No results.");
        return;
      }

      const [lng, lat] = f.center;
      m.flyTo({ center: [lng, lat], zoom: 16, essential: true });
    } catch (e) {
      console.error(e);
      setSearchErr("Search failed.");
    } finally {
      setSearching(false);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Save / Load project
  // ────────────────────────────────────────────────────────────────────────────
  function saveProject() {
    const m = mapRef.current;

    const projectData = {
      version: "1.0",
      timestamp: new Date().toISOString(),
      mapCenter: m ? [m.getCenter().lng, m.getCenter().lat] : [-90.1994, 38.627],
      mapZoom: m ? m.getZoom() : 14,
      mapBearing: m ? m.getBearing() : 0,
      placed,
      cables,
      billingTerm,
      customMapMode,
      customMapBounds,
    };

    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `green2go-project-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadProject(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);

        // Clear existing equipment nodes
        for (const node of equipNodesRef.current.values()) node.el.remove();
        equipNodesRef.current.clear();
        setPlaced([]);

        // Clear cables
        for (const node of outletNodesRef.current.values()) node.el.remove();
        outletNodesRef.current.clear();
        for (const node of quadCenterNodesRef.current.values()) node.el.remove();
        quadCenterNodesRef.current.clear();
        for (const node of cableLabelNodesRef.current.values()) node.el.remove();
        cableLabelNodesRef.current.clear();
        setCables([]);

        const m = mapRef.current;
        if (m && data.mapCenter) {
          m.jumpTo({
            center: data.mapCenter,
            zoom: data.mapZoom || 14,
            bearing: data.mapBearing || 0,
          });
        }

        if (data.billingTerm) setBillingTerm(data.billingTerm);
        if (Array.isArray(data.cables)) setCables(data.cables);

        if (Array.isArray(data.placed)) {
          setTimeout(() => {
            data.placed.forEach((item) => {
              placeEquipmentAt(item, item.lng, item.lat, item.id);
            });
          }, 50);
        }

        alert("Project loaded successfully!");
      } catch (err) {
        console.error("Error loading project:", err);
        alert("Error loading project file. Please check the file format.");
      }
    };
    reader.readAsText(file);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Custom map upload (PDF/Image overlay)
  // ────────────────────────────────────────────────────────────────────────────
  async function handleCustomMapUpload(file, fromHomePage = false) {
    if (!file) return;

    let m = mapRef.current;

    if (fromHomePage || !m) {
      let attempts = 0;
      while (!mapRef.current && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        attempts++;
      }
      m = mapRef.current;
      if (!m) {
        alert("Map failed to initialize. Try starting the map first, then upload.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    try {
      let imageUrl;

      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);

        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;

        imageUrl = canvas.toDataURL("image/png");
      } else if (file.type.startsWith("image/")) {
        imageUrl = URL.createObjectURL(file);
      } else {
        alert("Please upload a PDF or image file (PNG, JPG).");
        return;
      }

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUrl;
      });

      const center = m.getCenter();
      const aspect = img.width / img.height;
      const latSpan = 0.01;
      const lngSpan = latSpan * aspect;

      const bounds = [
        [center.lng - lngSpan / 2, center.lat - latSpan / 2],
        [center.lng + lngSpan / 2, center.lat + latSpan / 2],
      ];

      setCustomMapImage(imageUrl);
      setCustomMapBounds(bounds);
      setCustomMapMode(true);

      if (!m.isStyleLoaded()) {
        await new Promise((resolve) => m.once("style.load", resolve));
      }

      if (m.getSource("custom-map-overlay")) {
        if (m.getLayer("custom-map-overlay-layer")) m.removeLayer("custom-map-overlay-layer");
        m.removeSource("custom-map-overlay");
      }

      m.addSource("custom-map-overlay", {
        type: "image",
        url: imageUrl,
        coordinates: [
          [bounds[0][0], bounds[1][1]],
          [bounds[1][0], bounds[1][1]],
          [bounds[1][0], bounds[0][1]],
          [bounds[0][0], bounds[0][1]],
        ],
      });

      const layers = m.getStyle().layers;
      let firstSymbolId;
      for (const layer of layers) {
        if (layer.type === "symbol") {
          firstSymbolId = layer.id;
          break;
        }
      }

      m.addLayer(
        {
          id: "custom-map-overlay-layer",
          type: "raster",
          source: "custom-map-overlay",
          paint: { "raster-opacity": 1.0 },
        },
        firstSymbolId
      );

      const baseLayers = m.getStyle().layers;
      baseLayers.forEach((layer) => {
        if (layer.id !== "custom-map-overlay-layer" && layer.id !== cableLayerId && !layer.id.startsWith("custom-")) {
          try {
            m.setLayoutProperty(layer.id, "visibility", "none");
          } catch {
            // some base style layers (e.g. background) don't support visibility toggling
          }
        }
      });

      m.fitBounds(bounds, { padding: 20 });
    } catch (err) {
      console.error("Error uploading custom map:", err);
      alert("Error loading custom map: " + err.message);
    }
  }

  function removeCustomMap() {
    const m = mapRef.current;
    if (!m) return;

    if (m.getLayer("custom-map-overlay-layer")) m.removeLayer("custom-map-overlay-layer");
    if (m.getSource("custom-map-overlay")) m.removeSource("custom-map-overlay");

    const layers = m.getStyle().layers;
    layers.forEach((layer) => {
      if (layer.id !== cableLayerId && !layer.id.startsWith("custom-")) {
        try {
          m.setLayoutProperty(layer.id, "visibility", "visible");
        } catch {
          // some base style layers (e.g. background) don't support visibility toggling
        }
      }
    });

    if (customMapImage) {
      try {
        URL.revokeObjectURL(customMapImage);
      } catch {
        // customMapImage may not be a blob: URL (e.g. loaded from a saved project)
      }
    }

    setCustomMapImage(null);
    setCustomMapBounds(null);
    setCustomMapMode(false);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Export PDF (map image + BOM)
  // ────────────────────────────────────────────────────────────────────────────
  async function exportPDF() {
    const m = mapRef.current;
    if (!m) return;

    const defaultName = `green2go-quote-${new Date().toISOString().slice(0, 10)}`;
    const userFilename = prompt("Enter filename for PDF:", defaultName);
    if (userFilename === null) return;
    const cleanFilename = userFilename.trim().replace(/\.pdf$/i, "") || defaultName;

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));

      const doc = new jsPDF("l", "mm", "letter");
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();

      const panels = document.querySelectorAll("[data-ui-panel='true']");
      const prev = [];
      panels.forEach((el, i) => {
        prev[i] = el.style.display;
        el.style.display = "none";
      });

      const canvas = await html2canvas(mapDivRef.current, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: null,
        scale: 2,
      });

      panels.forEach((el, i) => (el.style.display = prev[i] ?? ""));

      const mapImage = canvas.toDataURL("image/png");

      const margin = 5;
      const imgWidth = pageWidth - 2 * margin;
      const imgHeight = pageHeight - 2 * margin;

      doc.addImage(mapImage, "PNG", margin, margin, imgWidth, imgHeight);

      doc.setFillColor(255, 255, 255);
      doc.rect(5, 5, 100, 18, "F");

      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(0, 0, 0);
      doc.text("Green2Go Event Quote", 10, 12);

      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, 10, 18);

      doc.addPage("p", "letter");
      const w2 = doc.internal.pageSize.getWidth();
      const h2 = doc.internal.pageSize.getHeight();
      let y = 15;

      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Bill of Materials", w2 / 2, y, { align: "center" });
      y += 10;

      const billingLabel = billingTerm === "day" ? "Daily" : billingTerm === "week" ? "Weekly" : "Monthly";
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(`Billing: ${billingLabel} rates`, 10, y);
      doc.text(`Items: ${placed.length} equipment, ${cables.length} cable runs`, w2 - 10, y, { align: "right" });
      y += 8;

      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text("Equipment", 10, y);
      y += 7;

      if (equipmentBom.length > 0) {
        doc.autoTable({
          startY: y,
          head: [["Qty", "Equipment", "Rate", "Subtotal"]],
          body: equipmentBom.map((r) => [String(r.qty), r.name, money(r.rate), money(r.subtotal)]),
          theme: "grid",
          styles: { fontSize: 9 },
          headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: "bold" },
          margin: { left: 10, right: 10 },
          columnStyles: {
            0: { cellWidth: 15, halign: "center" },
            1: { cellWidth: "auto" },
            2: { cellWidth: 30, halign: "right" },
            3: { cellWidth: 35, halign: "right" },
          },
        });
        y = doc.lastAutoTable.finalY + 3;
      } else {
        doc.setFontSize(9);
        doc.setFont("helvetica", "italic");
        doc.text("No equipment placed", 10, y);
        y += 7;
      }

      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(`Equipment Total: ${money(equipmentTotal)}`, w2 - 10, y, { align: "right" });
      y += 10;

      doc.setFontSize(14);
      doc.text("Cables", 10, y);
      y += 7;

      if (cableBom.length > 0) {
        doc.autoTable({
          startY: y,
          head: [["Qty", "Cable", "Rate", "Subtotal"]],
          body: cableBom.map((r) => [String(r.qty), r.name, money(r.rate), money(r.subtotal)]),
          theme: "grid",
          styles: { fontSize: 9 },
          headStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: "bold" },
          margin: { left: 10, right: 10 },
          columnStyles: {
            0: { cellWidth: 15, halign: "center" },
            1: { cellWidth: "auto" },
            2: { cellWidth: 30, halign: "right" },
            3: { cellWidth: 35, halign: "right" },
          },
        });
        y = doc.lastAutoTable.finalY + 3;
      } else {
        doc.setFontSize(9);
        doc.setFont("helvetica", "italic");
        doc.text("No cables placed", 10, y);
        y += 7;
      }

      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text(`Cable Total: ${money(cableTotal)}`, w2 - 10, y, { align: "right" });
      y += 12;

      doc.setDrawColor(0);
      doc.setLineWidth(0.8);
      doc.line(10, y - 5, w2 - 10, y - 5);

      doc.setFontSize(16);
      doc.text(`GRAND TOTAL: ${money(total)}`, w2 - 10, y + 3, { align: "right" });

      doc.setFontSize(8);
      doc.setFont("helvetica", "italic");
      doc.text(`Total Cable Footage: ${totalCableFeet.toFixed(1)} ft`, 10, h2 - 5);
      doc.text(`Page 2 of 2`, w2 - 10, h2 - 5, { align: "right" });

      doc.save(`${cleanFilename}.pdf`);
    } catch (err) {
      console.error("Error exporting PDF:", err);
      alert("Error creating PDF. Please try again.");
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Home page
  // ────────────────────────────────────────────────────────────────────────────
  if (showHomePage) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.98)",
            borderRadius: 24,
            padding: "48px 64px",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            maxWidth: 600,
            width: "90%",
          }}
        >
          <h1
            style={{
              margin: "0 0 12px 0",
              fontSize: 48,
              fontWeight: 900,
              background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              textAlign: "center",
            }}
          >
            Green2Go
          </h1>
          <p style={{ margin: "0 0 40px 0", fontSize: 18, color: "#666", textAlign: "center", fontWeight: 500 }}>
            Event Equipment Planner
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button
              onClick={() => setShowHomePage(false)}
              style={{
                ...baseBtn,
                width: "100%",
                padding: "20px 24px",
                fontSize: 18,
                fontWeight: 900,
                background: "linear-gradient(135deg, #00c853 0%, #00e676 100%)",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: 12,
                justifyContent: "center",
              }}
            >
              <span style={{ fontSize: 24 }}>🛰️</span>
              <span>Start with Satellite Map</span>
            </button>

            <label
              style={{
                ...baseBtn,
                width: "100%",
                padding: "20px 24px",
                fontSize: 18,
                fontWeight: 900,
                background: "linear-gradient(135deg, #2196f3 0%, #42a5f5 100%)",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: 12,
                justifyContent: "center",
                cursor: "pointer",
                margin: 0,
              }}
            >
              <span style={{ fontSize: 24 }}>🗺️</span>
              <span>Upload Custom Map (PDF/Image)</span>
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={async (e) => {
                  if (e.target.files[0]) {
                    const file = e.target.files[0];
                    setShowHomePage(false);
                    await handleCustomMapUpload(file, true);
                    e.target.value = "";
                  }
                }}
                style={{ display: "none" }}
              />
            </label>

            <label
              style={{
                ...baseBtn,
                width: "100%",
                padding: "20px 24px",
                fontSize: 18,
                fontWeight: 900,
                background: "linear-gradient(135deg, #ff9800 0%, #ffb74d 100%)",
                border: "none",
                display: "flex",
                alignItems: "center",
                gap: 12,
                justifyContent: "center",
                cursor: "pointer",
                margin: 0,
              }}
            >
              <span style={{ fontSize: 24 }}>📂</span>
              <span>Load Existing Project</span>
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  if (e.target.files[0]) {
                    setShowHomePage(false);
                    setTimeout(() => loadProject(e.target.files[0]), 400);
                    e.target.value = "";
                  }
                }}
                style={{ display: "none" }}
              />
            </label>
          </div>

          <p style={{ marginTop: 32, fontSize: 13, color: "#999", textAlign: "center", fontWeight: 500 }}>
            Plan event layouts • Generate quotes • Export PDFs
          </p>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // UI bits (same as before; kept intact)
  // ────────────────────────────────────────────────────────────────────────────
  const equipmentTotal2 = equipmentTotal; // alias for clarity

  const equipmentButtonLabel = tool === "cable" ? "Equipment" : "Equipment";
  const totalLabel = money(total);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div
        ref={mapDivRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleMapDrop}
        style={{ width: "100%", height: "100%" }}
      />

      {/* SEARCH */}
      <div
        data-ui-panel="true"
        style={{
          ...uiPanelStyle,
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(720px, calc(100vw - 24px))",
          zIndex: 70,
          padding: 10,
          borderRadius: 14,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search address / venue…"
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.18)",
              outline: "none",
              color: "#111",
              background: "#fff",
              fontWeight: 800,
            }}
          />
          <button onClick={runSearch} disabled={searching} style={baseBtn}>
            {searching ? "Searching…" : "Go"}
          </button>
        </div>
        {searchErr ? <div style={{ marginTop: 6, fontSize: 12, color: "#b00020", fontWeight: 900 }}>{searchErr}</div> : null}
      </div>

      {/* FILE MENU */}
      <div
        data-ui-panel="true"
        style={{
          ...uiPanelStyle,
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 70,
          padding: "8px 12px",
          borderRadius: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 900 }}>File:</div>

        <button onClick={saveProject} style={{ ...lightBtn, padding: "6px 10px", fontSize: 12 }}>
          💾 Save
        </button>

        <label style={{ ...lightBtn, margin: 0, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>
          📂 Load
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              if (e.target.files[0]) {
                loadProject(e.target.files[0]);
                e.target.value = "";
              }
            }}
            style={{ display: "none" }}
          />
        </label>

        {customMapImage ? (
          <button
            onClick={removeCustomMap}
            style={{
              ...lightBtn,
              padding: "6px 10px",
              fontSize: 12,
              background: "#ffebee",
              color: "#d32f2f",
              border: "1px solid #d32f2f",
            }}
          >
            🗑️ Remove Map
          </button>
        ) : (
          <label style={{ ...lightBtn, margin: 0, cursor: "pointer", padding: "6px 10px", fontSize: 12 }}>
            🗺️ Upload Map
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => {
                if (e.target.files[0]) {
                  handleCustomMapUpload(e.target.files[0], false);
                  e.target.value = "";
                }
              }}
              style={{ display: "none" }}
            />
          </label>
        )}

        <button onClick={exportPDF} style={{ ...lightBtn, padding: "6px 10px", fontSize: 12 }}>
          📄 Export PDF
        </button>
      </div>

      {/* BOTTOM LEFT CONTROLS */}
      <div
        data-ui-panel="true"
        style={{
          position: "absolute",
          bottom: 12,
          left: 12,
          zIndex: 60,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button onClick={() => setShowEquipment(true)} style={baseBtn}>
          {equipmentButtonLabel}
        </button>

        <button
          onClick={() => {
            setTool((t) => (t === "cable" ? "select" : "cable"));
            clearCableDraft();
          }}
          style={{
            ...baseBtn,
            background: tool === "cable" ? "#00c853" : "#111",
          }}
        >
          {tool === "cable" ? "Cable Tool: ON" : "Cable Tool"}
        </button>

        {tool === "cable" && (
          <div
            style={{
              ...uiPanelStyle,
              padding: "8px 10px",
              borderRadius: 12,
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 900 }}>Type</div>
            <select value={cableType} onChange={(e) => setCableType(e.target.value)} style={{ fontWeight: 900 }}>
              <option value="50A">50A</option>
              <option value="30A">30A</option>
              <option value="BANDED">Banded / 2/5</option>
              <option value="FOUR_O">4/0</option>
              <option value="QUAD">Quad</option>
            </select>
            <button onClick={clearCableDraft} style={lightBtn}>
              Cancel Draft
            </button>
          </div>
        )}

        <div
          style={{
            ...uiPanelStyle,
            padding: "8px 10px",
            borderRadius: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 900 }}>Billing:</div>
          <select value={billingTerm} onChange={(e) => setBillingTerm(e.target.value)} style={{ fontWeight: 900 }}>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </div>

        <div style={{ ...uiPanelStyle, padding: "6px 10px", borderRadius: 12, fontSize: 11, fontWeight: 900, opacity: 0.85 }}>
          💡 Shift+Drag to move equipment | Ctrl+Shift+Right Click cable to delete
        </div>
      </div>

      {/* BOM BUTTON */}
      <div data-ui-panel="true" style={{ position: "absolute", bottom: 12, right: 12, zIndex: 60, display: "flex", gap: 8 }}>
        <button onClick={() => setShowBom(true)} style={baseBtn}>
          BOM / Total: {totalLabel}
        </button>
      </div>

      {/* CABLE DRAFT HUD */}
      {tool === "cable" && (
        <div
          data-ui-panel="true"
          style={{
            ...uiPanelStyle,
            position: "absolute",
            bottom: 64,
            left: 12,
            zIndex: 65,
            padding: 10,
            borderRadius: 12,
            width: 420,
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 4 }}>Cable Tool</div>
          {cableType === "QUAD" ? (
            <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800 }}>Click to place a 50ft Quad with 3 outlet boxes.</div>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800 }}>Click start point, then click end point.</div>
              {cableDraftStart ? (
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 900 }}>
                  Draft: {draftFeet.toFixed(1)} ft{" "}
                  <span style={{ opacity: 0.75, fontWeight: 800 }}>
                    (auto: {best50_100(draftFeet).n100}×100 + {best50_100(draftFeet).n50}×50)
                  </span>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8, fontWeight: 800 }}>Waiting for start click…</div>
              )}
            </>
          )}
        </div>
      )}

      {/* EQUIPMENT POPUP */}
      {showEquipment && (
        <>
          <div
            data-ui-panel="true"
            onClick={() => setShowEquipment(false)}
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)", zIndex: 80 }}
          />
          <div
            data-ui-panel="true"
            style={{
              ...uiPanelStyle,
              position: "absolute",
              left: 12,
              bottom: 60,
              width: 460,
              maxHeight: "70vh",
              overflow: "auto",
              padding: 12,
              borderRadius: 12,
              zIndex: 90,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Equipment</h3>
              <button onClick={() => setShowEquipment(false)} style={lightBtn}>
                Close ✕
              </button>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 900 }}>Billing:</div>
              <select value={billingTerm} onChange={(e) => setBillingTerm(e.target.value)} style={{ fontWeight: 900 }}>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </select>
              <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.75, fontWeight: 900 }}>Loaded: {catalog.length}</div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 900 }}>Size:</div>
              <button
                onClick={() => setEquipSizeAdjust((v) => Math.max(0.3, Math.round((v - 0.1) * 10) / 10))}
                style={{ ...lightBtn, padding: "2px 10px", fontSize: 14, lineHeight: 1 }}
              >
                −
              </button>
              <div style={{ fontSize: 12, fontWeight: 900, minWidth: 36, textAlign: "center" }}>
                {Math.round(equipSizeAdjust * 100)}%
              </div>
              <button
                onClick={() => setEquipSizeAdjust((v) => Math.min(3, Math.round((v + 0.1) * 10) / 10))}
                style={{ ...lightBtn, padding: "2px 10px", fontSize: 14, lineHeight: 1 }}
              >
                +
              </button>
            </div>

            {groups.length === 0 ? (
              <div style={{ opacity: 0.9, fontSize: 12, fontWeight: 900 }}>
                No equipment loaded. Confirm <code>/public/data/catalog.csv</code>.
              </div>
            ) : (
              groups.map(([gp, items]) => (
                <details key={gp} style={{ marginBottom: 10 }}>
                  <summary style={{ fontWeight: 900, cursor: "pointer", padding: "6px 0" }}>{gp}</summary>
                  <div style={{ marginTop: 8 }}>
                    {items.map((it) => (
                      <button
                        key={`${gp}-${it.name}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/json", JSON.stringify(it));
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => addItem(it)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: 10,
                          marginBottom: 8,
                          borderRadius: 10,
                          cursor: "grab",
                          background: "#fff",
                          color: "#111",
                          border: "1px solid rgba(0,0,0,0.15)",
                          fontWeight: 900,
                        }}
                      >
                        {it.name}
                      </button>
                    ))}
                  </div>
                </details>
              ))
            )}
          </div>
        </>
      )}

      {/* BOM DRAWER */}
      {showBom && (
        <>
          <div
            data-ui-panel="true"
            onClick={() => setShowBom(false)}
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 80 }}
          />
          <div
            data-ui-panel="true"
            style={{
              ...uiPanelStyle,
              position: "absolute",
              top: 0,
              right: 0,
              width: 640,
              height: "100vh",
              padding: 14,
              zIndex: 90,
              overflow: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>BOM + Total</h3>
              <button onClick={() => setShowBom(false)} style={lightBtn}>
                Close ✕
              </button>
            </div>

            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 8, marginBottom: 10, fontWeight: 900 }}>
              Equipment placed: {placed.length} • Cable runs: {cables.length} • Cable drawn: {totalCableFeet.toFixed(1)} ft
            </div>

            <div style={{ padding: 10, borderRadius: 10, background: "#fff", border: "1px solid rgba(0,0,0,0.12)" }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Equipment</div>
              {equipmentBom.length === 0 ? (
                <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.8 }}>No equipment yet.</div>
              ) : (
                equipmentBom.map((r) => (
                  <div
                    key={`eq-${r.gp}-${r.name}`}
                    style={{ display: "grid", gridTemplateColumns: "50px 1fr 90px 100px", gap: 10, padding: "6px 0" }}
                  >
                    <div style={{ fontWeight: 900 }}>{r.qty}×</div>
                    <div style={{ fontWeight: 800 }}>{r.name}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{money(r.rate)}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{money(r.subtotal)}</div>
                  </div>
                ))
              )}
              <div style={{ borderTop: "1px solid rgba(0,0,0,0.12)", marginTop: 8, paddingTop: 8, fontWeight: 900, textAlign: "right" }}>
                Equipment Total: {money(equipmentTotal2)}
              </div>
            </div>

            <div style={{ height: 10 }} />

            <div style={{ padding: 10, borderRadius: 10, background: "#fff", border: "1px solid rgba(0,0,0,0.12)" }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Cables</div>
              {cableBom.length === 0 ? (
                <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.8 }}>No cables yet.</div>
              ) : (
                cableBom.map((r) => (
                  <div key={`cb-${r.name}`} style={{ display: "grid", gridTemplateColumns: "50px 1fr 90px 100px", gap: 10, padding: "6px 0" }}>
                    <div style={{ fontWeight: 900 }}>{r.qty}×</div>
                    <div style={{ fontWeight: 800 }}>
                      {r.name} {!r.matched ? <span style={{ color: "#b00020" }}>(not in CSV)</span> : null}
                    </div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{money(r.rate)}</div>
                    <div style={{ textAlign: "right", fontWeight: 900 }}>{money(r.subtotal)}</div>
                  </div>
                ))
              )}
              <div style={{ borderTop: "1px solid rgba(0,0,0,0.12)", marginTop: 8, paddingTop: 8, fontWeight: 900, textAlign: "right" }}>
                Cable Total: {money(cableTotal)}
              </div>
            </div>

            <div style={{ height: 14 }} />

            <div style={{ padding: 12, borderRadius: 12, background: "#111", color: "#fff", fontWeight: 900, fontSize: 16, textAlign: "right" }}>
              GRAND TOTAL: {money(total)}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 900, opacity: 0.8 }}>
              Cable catalog availability (from CSV):{" "}
              {["50", "100"].map((len) => (
                <span key={len} style={{ marginLeft: 10 }}>
                  {len}ft — 50A:{cableIndex[len]["50A"].length} 30A:{cableIndex[len]["30A"].length} 2/5:{cableIndex[len]["BANDED"].length} 4/0:
                  {cableIndex[len]["FOUR_O"].length} QUAD:{cableIndex[len]["QUAD"].length}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}