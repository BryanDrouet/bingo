import { escapeHtml, prefersReducedMotion } from "./ui.js";

let themeTransitionTimeout = null;
const PATTERN_ALL_ZOOMS = [0.5, 1, 1.5, 2];
const ALLOWED_CATEGORY_PATTERN_KEYS = new Set([
    "argyle",
    "brady-bunch",
    "upholstery",
    "carbon",
    "cross-dots",
    "japanese-cube",
    "conic-checker",
    "diagonal-checkerboard",
    "carbon-fibre",
    "blueprint-grid",
    "tablecloth",
    "dots",
    "polka-dot",
    "horizontal-stripes",
    "vertical-stripes",
    "shippo",
    "tartan",
    "waves"
]);
const PATTERN_ZOOM_RULES = {
    argyle: [0.5, 1.5],
    "brady-bunch": [0.5],
    "cross-dots": [0.5],
    "japanese-cube": [1],
    "polka-dot": [0.5],
    shippo: [1],
    tartan: [1.5, 2],
    waves: [1]
};

export function normalizeHexColor(value, fallback = "#CC0000") {
    const input = String(value || "").trim();
    const shortMatch = input.match(/^#?([a-f\d]{3})$/i);
    if (shortMatch) {
        const [, shortHex] = shortMatch;
        const expanded = shortHex
            .split("")
            .map(char => char + char)
            .join("");
        return `#${expanded.toUpperCase()}`;
    }

    const fullMatch = input.match(/^#?([a-f\d]{6})$/i);
    if (fullMatch) {
        return `#${fullMatch[1].toUpperCase()}`;
    }

    return fallback;
}

export function normalizeCssVarContent(value) {
    return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

export function getAllowedPatternZooms(patternKey = "none") {
    const key = String(patternKey || "none").trim();
    if (key === "none") return [1];

    const configured = PATTERN_ZOOM_RULES[key];
    const source = Array.isArray(configured) ? configured : PATTERN_ALL_ZOOMS;
    const values = [...new Set([...source, 1])]
        .map(entry => Number.parseFloat(entry))
        .filter(entry => Number.isFinite(entry) && entry >= 0.5 && entry <= 2)
        .map(entry => Math.round(entry * 2) / 2)
        .sort((a, b) => a - b);

    return values.length ? values : [1];
}

export function normalizePatternZoom(value, fallback = 1, patternKey = null) {
    const allowed = getAllowedPatternZooms(patternKey || "");
    const fallbackValue = Number.isFinite(Number.parseFloat(fallback))
        ? Number.parseFloat(fallback)
        : allowed[0];
    const parsed = Number.parseFloat(value);
    const target = Number.isFinite(parsed) ? parsed : fallbackValue;

    let closest = allowed[0];
    for (const candidate of allowed) {
        if (Math.abs(candidate - target) < Math.abs(closest - target)) {
            closest = candidate;
        }
    }

    return closest;
}

export function getSmallestPatternZoom(patternKey = "none") {
    const allowed = getAllowedPatternZooms(patternKey);
    return allowed[0] || 1;
}

export function scalePatternSize(sizeValue, zoom = 1) {
    const normalizedZoom = normalizePatternZoom(zoom, 1);
    const rawSize = String(sizeValue || "").trim();
    const size = rawSize || "40px 40px";
    if (size === "auto" || normalizedZoom === 1) return size;

    return size.replace(/(-?\d*\.?\d+)px/gi, (_, value) => {
        const scaled = Number.parseFloat(value) * normalizedZoom;
        const rounded = Math.max(0.1, scaled).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
        return `${rounded}px`;
    });
}

export function humanizePatternKey(key) {
    return String(key || "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, char => char.toUpperCase());
}

export function getCategoryPatternPresets() {
    const rootStyles = getComputedStyle(document.documentElement);
    const grouped = {};

    for (let index = 0; index < rootStyles.length; index += 1) {
        const propertyName = rootStyles[index];
        const match = propertyName.match(/^--category-pattern-([a-z\d-]+)-(label|image|size|position)$/i);
        if (!match) continue;
        const [, key, field] = match;
        grouped[key] = grouped[key] || { key };
        grouped[key][field] = normalizeCssVarContent(rootStyles.getPropertyValue(propertyName));
    }

    const dynamicPresets = Object.values(grouped)
        .filter(entry => entry.image)
        .map(entry => ({
            key: entry.key,
            label: entry.label || humanizePatternKey(entry.key),
            image: entry.image,
            size: entry.size || "40px 40px",
            position: entry.position || "0 0"
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "fr"));

    const fallbackPresets = [
        {
            key: "conic-checker",
            label: "Damier conique",
            image: "repeating-conic-gradient(rgba(0,0,0,0.14) 0% 25%, transparent 0% 50%)",
            size: "38px 38px",
            position: "0 0"
        },
        {
            key: "diagonal-stripes",
            label: "Rayures diagonales",
            image: "repeating-linear-gradient(45deg, rgba(0,0,0,0.14) 0 6px, transparent 6px 12px)",
            size: "34px 34px",
            position: "0 0"
        },
        {
            key: "dots",
            label: "Pois",
            image: "radial-gradient(circle, rgba(0,0,0,0.18) 0 3px, transparent 4px)",
            size: "26px 26px",
            position: "0 0"
        }
    ];

    const presets = (dynamicPresets.length ? dynamicPresets : fallbackPresets)
        .filter(preset => ALLOWED_CATEGORY_PATTERN_KEYS.has(preset.key));
    return [{ key: "none", label: "Aucun motif", image: "none", size: "auto", position: "0 0" }, ...presets];
}

export function normalizeCategoryPatternKey(value, fallback = "none") {
    const key = String(value || "").trim();
    if (!key) return fallback;
    const presets = getCategoryPatternPresets();
    return presets.some(preset => preset.key === key) ? key : fallback;
}

export function getCategoryPatternPresetByKey(patternKey) {
    const presets = getCategoryPatternPresets();
    return presets.find(preset => preset.key === patternKey) || presets[0];
}

export function buildCategoryPatternOptions(selectedPattern = "none") {
    const normalized = normalizeCategoryPatternKey(selectedPattern, "none");
    return getCategoryPatternPresets().map(preset =>
        `<option value="${escapeHtml(preset.key)}" ${preset.key === normalized ? "selected" : ""}>${escapeHtml(preset.label)}</option>`
    ).join("");
}

export function applyPatternPreview(previewElement, patternKey = "none", options = {}) {
    if (!previewElement) return;
    const preset = getCategoryPatternPresetByKey(normalizeCategoryPatternKey(patternKey, "none"));
    const color = normalizeHexColor(options.color, "#CC0000");
    const zoom = getSmallestPatternZoom(preset.key);
    const computedRootStyles = getComputedStyle(document.documentElement);
    const patternOpacity = (computedRootStyles.getPropertyValue("--theme-pattern-opacity") || "0.42").trim() || "0.42";

    previewElement.style.setProperty("--preview-pattern-color", color);
    previewElement.style.setProperty("--preview-pattern-image", preset.image === "none" ? "none" : preset.image);
    previewElement.style.setProperty("--preview-pattern-size", scalePatternSize(preset.size || "40px 40px", zoom));
    previewElement.style.setProperty("--preview-pattern-position", preset.position || "0 0");
    previewElement.style.setProperty("--preview-pattern-opacity", preset.key === "none" ? "0" : patternOpacity);
    previewElement.style.setProperty("--pattern-zoom", String(zoom));
    previewElement.classList.toggle("is-empty", preset.key === "none");
}

export function hexToRgb(hexColor) {
    const color = normalizeHexColor(hexColor);
    const hex = color.slice(1);
    return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16)
    };
}

export function hexToRgba(hexColor, alpha = 1) {
    const { r, g, b } = hexToRgb(hexColor);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function darkenHexColor(hexColor, percent = 18) {
    const { r, g, b } = hexToRgb(hexColor);
    const ratio = Math.max(0, Math.min(percent, 100)) / 100;
    const shade = channel => Math.max(0, Math.round(channel * (1 - ratio)));
    const toHex = value => value.toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(shade(r))}${toHex(shade(g))}${toHex(shade(b))}`;
}

export function getReadableTextColor(hexColor) {
    const { r, g, b } = hexToRgb(hexColor);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.62 ? "#111111" : "#FFFFFF";
}

export function buildCategoryInlineStyle(color, pattern = "none", zoom = 1) {
    const base = normalizeHexColor(color);
    const normalizedPatternKey = normalizeCategoryPatternKey(pattern, "none");
    const preset = getCategoryPatternPresetByKey(normalizedPatternKey);
    const normalizedZoom = normalizePatternZoom(zoom, getSmallestPatternZoom(normalizedPatternKey), normalizedPatternKey);
    return [
        `--category-color:${base}`,
        `--category-color-dark:${darkenHexColor(base, 22)}`,
        `--category-bg:${hexToRgba(base, 0.6)}`,
        `--category-border:${hexToRgba(base)}`,
        `--category-text:${getReadableTextColor(base)}`,
        `--category-pattern-image:${preset.image === "none" ? "none" : preset.image}`,
        `--category-pattern-size:${scalePatternSize(preset.size || "40px 40px", normalizedZoom)}`,
        `--category-pattern-position:${preset.position || "0 0"}`
    ].join(";");
}

export function buildBingoAccentStyle(color) {
    const base = normalizeHexColor(color);
    return [
        `--bingo-accent:${base}`,
        `--bingo-accent-dark:${darkenHexColor(base, 22)}`,
        `--bingo-accent-contrast:${getReadableTextColor(base)}`
    ].join(";");
}

export function normalizeCategoryName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isReservedCategoryName(value) {
    const normalized = normalizeCategoryName(value);
    return normalized === "ajouter une catégorie...";
}

export function isDefaultCategoryName(value) {
    const normalized = normalizeCategoryName(value);
    const defaultNames = new Set([
        normalizeCategoryName("Sans catégorie"),
        normalizeCategoryName("Toutes les catégories"),
        normalizeCategoryName("Toutes les categories"),
        normalizeCategoryName("Tous")
    ]);
    return defaultNames.has(normalized) || isReservedCategoryName(value);
}

export function buildCategoryRegistry(bingos) {
    const byKey = {};
    const list = [];
    (bingos || []).forEach(bingo => {
        const name = String(bingo?.category || "").trim();
        const key = normalizeCategoryName(name);
        if (!key || key === normalizeCategoryName("Sans catégorie") || isReservedCategoryName(name)) return;
        if (byKey[key]) return;
        const color = normalizeHexColor(bingo?.categoryColor, "#CC0000");
        const pattern = normalizeCategoryPatternKey(bingo?.categoryPattern, "none");
        const patternZoom = normalizePatternZoom(bingo?.categoryPatternZoom, 1, pattern);
        const entry = { name, key, color, pattern, patternZoom };
        byKey[key] = entry;
        list.push(entry);
    });
    return {
        byKey,
        list,
        colorByName: Object.fromEntries(list.map(entry => [entry.name, entry.color]))
    };
}

export function buildCategoryTagMarkup(category, color, pattern = "none", extraClass = "") {
    const className = ["tag-category", extraClass].filter(Boolean).join(" ");
    return `<span class="${className}" style="${buildCategoryInlineStyle(color, pattern)}">${escapeHtml(category || "Sans catégorie")}</span>`;
}

export function buildHeaderTagMarkup(text) {
    return `<span class="header-tag header-tag-live">${escapeHtml(text || "Bingo")}</span>`;
}

export function startBodyThemeTransition() {
    const body = document.body;
    if (!body || prefersReducedMotion()) return;

    const styles = getComputedStyle(body);
    const prevRed = styles.getPropertyValue("--theme-red").trim() || "#CC0000";
    const prevPatternImage = styles.getPropertyValue("--theme-pattern-image").trim() || "repeating-conic-gradient(rgba(0,0,0,0.06) 0% 25%, transparent 0% 50%)";
    const prevPatternSize = styles.getPropertyValue("--theme-pattern-size").trim() || "40px 40px";
    const prevPatternPosition = styles.getPropertyValue("--theme-pattern-position").trim() || "0 0";
    const prevPatternOpacity = styles.getPropertyValue("--theme-pattern-opacity").trim() || "0.42";

    body.style.setProperty("--theme-prev-red", prevRed);
    body.style.setProperty("--theme-prev-pattern-image", prevPatternImage);
    body.style.setProperty("--theme-prev-pattern-size", prevPatternSize);
    body.style.setProperty("--theme-prev-pattern-position", prevPatternPosition);
    body.style.setProperty("--theme-prev-pattern-opacity", prevPatternOpacity);
    body.style.setProperty("--theme-prev-opacity", prevPatternOpacity);

    window.requestAnimationFrame(() => {
        body.style.setProperty("--theme-prev-opacity", "0");
    });

    if (themeTransitionTimeout) clearTimeout(themeTransitionTimeout);
    themeTransitionTimeout = window.setTimeout(() => {
        body.style.removeProperty("--theme-prev-red");
        body.style.removeProperty("--theme-prev-pattern-image");
        body.style.removeProperty("--theme-prev-pattern-size");
        body.style.removeProperty("--theme-prev-pattern-position");
        body.style.removeProperty("--theme-prev-pattern-opacity");
        body.style.removeProperty("--theme-prev-opacity");
    }, 360);
}

export function applyBodyAccentTheme(color, pattern = "none", zoom = 1) {
    const body = document.body;
    if (!body) return;
    startBodyThemeTransition();
    const base = normalizeHexColor(color, "#CC0000");
    const onBase = getReadableTextColor(base);
    const isLightBase = onBase === "#111111";
    const preset = getCategoryPatternPresetByKey(normalizeCategoryPatternKey(pattern, "none"));

    body.style.setProperty("--theme-red", base);
    body.style.setProperty("--theme-red-dark", darkenHexColor(base, 22));
    body.style.setProperty("--theme-error", isLightBase ? darkenHexColor(base, 55) : base);
    body.style.setProperty("--theme-on-red", onBase);
    body.style.setProperty("--theme-on-red-soft", hexToRgba(onBase, 0.72));
    if (preset.key === "none") {
        body.style.setProperty("--theme-pattern-image", "none");
        body.style.setProperty("--theme-pattern-size", "auto");
        body.style.setProperty("--theme-pattern-position", "0 0");
        body.style.setProperty("--theme-pattern-opacity", "0");
    } else {
        const normalizedZoom = normalizePatternZoom(zoom, getSmallestPatternZoom(preset.key), preset.key);
        body.style.setProperty("--theme-pattern-image", preset.image);
        body.style.setProperty("--theme-pattern-size", scalePatternSize(preset.size || "40px 40px", normalizedZoom));
        body.style.setProperty("--theme-pattern-position", preset.position || "0 0");
        body.style.setProperty("--theme-pattern-opacity", "0.42");
    }
    body.style.setProperty("--header-tag-bg", base);
    body.style.setProperty("--header-tag-text", onBase);
}

export function resetBodyAccentTheme() {
    const body = document.body;
    if (!body) return;
    startBodyThemeTransition();
    body.style.removeProperty("--theme-red");
    body.style.removeProperty("--theme-red-dark");
    body.style.removeProperty("--theme-error");
    body.style.removeProperty("--theme-on-red");
    body.style.removeProperty("--theme-on-red-soft");
    body.style.removeProperty("--theme-pattern-image");
    body.style.removeProperty("--theme-pattern-size");
    body.style.removeProperty("--theme-pattern-position");
    body.style.removeProperty("--theme-pattern-opacity");
    body.style.removeProperty("--header-tag-bg");
    body.style.removeProperty("--header-tag-text");
}
