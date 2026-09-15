import { escapeHtml } from "./ui.js";
import { currentUser } from "./session.js";

export const MAX_PROFILE_IMAGE_FILE_BYTES = 6 * 1024 * 1024;
export const PROFILE_AVATAR_OUTPUT_SIZE = 512;
export const PROFILE_AVATAR_CROP_BOX_SIZE = 180;
export const PROFILE_AVATAR_MIN_ZOOM = 1;
export const PROFILE_AVATAR_MAX_ZOOM = 3;
export const PROFILE_CROPPER_TRANSITION_MS = 180;
const AVATAR_CROP_HASH_MARKER = "#avatarCrop=";
const ALLOWED_PROFILE_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
]);

export function stripAvatarCropMeta(url) {
    if (!url || typeof url !== "string") return "";
    const markerIndex = url.indexOf(AVATAR_CROP_HASH_MARKER);
    return markerIndex === -1 ? url : url.slice(0, markerIndex);
}

export function parseAvatarCropMeta(url) {
    if (!url || typeof url !== "string") return null;
    const markerIndex = url.indexOf(AVATAR_CROP_HASH_MARKER);
    if (markerIndex === -1) return null;
    const encoded = url.slice(markerIndex + AVATAR_CROP_HASH_MARKER.length);
    if (!encoded) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(encoded));
        const x = Number(parsed?.x);
        const y = Number(parsed?.y);
        const sw = Number(parsed?.sw);
        const sh = Number(parsed?.sh);
        if (![x, y, sw, sh].every(Number.isFinite)) return null;
        if (sw <= 0 || sh <= 0) return null;
        return {
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
            sw: Math.min(1, Math.max(0.0001, sw)),
            sh: Math.min(1, Math.max(0.0001, sh))
        };
    } catch {
        return null;
    }
}

export function appendAvatarCropMeta(url, cropMeta) {
    const cleanUrl = stripAvatarCropMeta(url);
    if (!cropMeta) return cleanUrl;
    return `${cleanUrl}${AVATAR_CROP_HASH_MARKER}${encodeURIComponent(JSON.stringify(cropMeta))}`;
}

export function buildAvatarCropInlineStyle(cropMeta) {
    if (!cropMeta) return "";
    const widthPct = (100 / cropMeta.sw).toFixed(5);
    const heightPct = (100 / cropMeta.sh).toFixed(5);
    const leftPct = (-(cropMeta.x / cropMeta.sw) * 100).toFixed(5);
    const topPct = (-(cropMeta.y / cropMeta.sh) * 100).toFixed(5);
    return `--avatar-crop-w:${widthPct}%;--avatar-crop-h:${heightPct}%;--avatar-crop-x:${leftPct}%;--avatar-crop-y:${topPct}%;`;
}

export function renderAvatarImage(url, altText, imageClass, { id = "", hostClass = "" } = {}) {
    const cropMeta = parseAvatarCropMeta(url);
    const cleanUrl = stripAvatarCropMeta(url);
    const idAttr = id ? ` id="${id}"` : "";
    if (!cropMeta) {
        return `<img src="${escapeHtml(cleanUrl)}" alt="${escapeHtml(altText)}" class="${imageClass}"${idAttr}>`;
    }

    return `
        <span class="avatar-crop-host ${hostClass}">
            <img src="${escapeHtml(cleanUrl)}" alt="${escapeHtml(altText)}" class="${imageClass} avatar-crop-image" style="${buildAvatarCropInlineStyle(cropMeta)}"${idAttr}>
        </span>
    `;
}

export function getDefaultProviderPhotoUrl(user = currentUser) {
    if (!user) return "";
    const providerPhoto = (user.providerData || []).find(item => typeof item?.photoURL === "string" && item.photoURL.trim());
    return providerPhoto?.photoURL?.trim() || "";
}

export function getInitialsFromIdentity(displayName = "", email = "") {
    const fromName = String(displayName || "").trim();
    const fromEmail = String(email || "").trim();
    const source = fromName || fromEmail.split("@")[0] || "Utilisateur";
    const words = source
        .replace(/[._-]+/g, " ")
        .split(/\s+/)
        .map(token => token.replace(/[^\p{L}\p{N}]+/gu, ""))
        .filter(Boolean);

    if (!words.length) return "U";
    if (words.length === 1) {
        const letters = Array.from(words[0]).slice(0, 2).join("").toUpperCase();
        return letters || "U";
    }

    const first = (Array.from(words[0])[0] || "").toUpperCase();
    const second = (Array.from(words[1])[0] || "").toUpperCase();
    return `${first}${second}` || "U";
}

export function hashStringToInt(input = "") {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

export function hslToRgb(h, s, l) {
    const hue = (((h % 360) + 360) % 360) / 360;
    const sat = Math.max(0, Math.min(100, s)) / 100;
    const lig = Math.max(0, Math.min(100, l)) / 100;

    if (sat === 0) {
        const gray = Math.round(lig * 255);
        return { r: gray, g: gray, b: gray };
    }

    const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
    const p = (2 * lig) - q;
    const convert = t => {
        let value = t;
        if (value < 0) value += 1;
        if (value > 1) value -= 1;
        if (value < 1 / 6) return p + ((q - p) * 6 * value);
        if (value < 1 / 2) return q;
        if (value < 2 / 3) return p + ((q - p) * (2 / 3 - value) * 6);
        return p;
    };

    return {
        r: Math.round(convert(hue + 1 / 3) * 255),
        g: Math.round(convert(hue) * 255),
        b: Math.round(convert(hue - 1 / 3) * 255)
    };
}

export function toHexColor(rgb) {
    const toHex = channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function getReadableTextColorFromRgb(rgb) {
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance > 0.62 ? "#111111" : "#FFFFFF";
}

export function createGeneratedInitialsAvatarUrl({ displayName = "", email = "", uid = "", seed = "" } = {}) {
    const initials = getInitialsFromIdentity(displayName, email);
        const guestSeed = String(uid || seed || `${displayName}-${email}` || "invite").slice(0, 24) || "invite";
        const randomSeed = `${guestSeed}-${seed || Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const hash = hashStringToInt(randomSeed);
    const hueA = hash % 360;
    const hueB = (hueA + 35 + (hash % 70)) % 360;
        const bgA = hslToRgb(hueA, 70, 50);
        const bgB = hslToRgb(hueB, 66, 40);
    const avgBg = {
        r: Math.round((bgA.r + bgB.r) / 2),
        g: Math.round((bgA.g + bgB.g) / 2),
        b: Math.round((bgA.b + bgB.b) / 2)
    };
    const textColor = getReadableTextColorFromRgb(avgBg);
        const safeInitials = escapeHtml(initials.slice(0, 2));
    const strokeColor = textColor === "#111111" ? "rgba(255,255,255,0.32)" : "rgba(0,0,0,0.30)";
        const fontSize = safeInitials.length > 1 ? 178 : 198;

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Avatar ${initials}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${toHexColor(bgA)}" />
      <stop offset="100%" stop-color="${toHexColor(bgB)}" />
    </linearGradient>
        <radialGradient id="softLight" cx="82%" cy="18%" r="70%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.18)" />
            <stop offset="70%" stop-color="rgba(255,255,255,0.04)" />
            <stop offset="100%" stop-color="rgba(255,255,255,0)" />
        </radialGradient>
        <radialGradient id="softShade" cx="18%" cy="88%" r="85%">
            <stop offset="0%" stop-color="rgba(0,0,0,0.18)" />
            <stop offset="70%" stop-color="rgba(0,0,0,0.05)" />
            <stop offset="100%" stop-color="rgba(0,0,0,0)" />
        </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)" />
    <rect width="512" height="512" fill="url(#softLight)" />
    <rect width="512" height="512" fill="url(#softShade)" />
    <text
        x="256"
        y="256"
        text-anchor="middle"
        dominant-baseline="middle"
        dy="0.055em"
        fill="${textColor}"
        stroke="${strokeColor}"
        stroke-width="2"
        paint-order="stroke"
        font-family="Segoe UI, Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
        letter-spacing="3"
    >${safeInitials}</text>
</svg>`;

    return `data:image/svg+xml;generated-avatar=1,${encodeURIComponent(svg.trim())}`;
}

export function isGeneratedInitialsAvatarUrl(url = "") {
    return /^data:image\/svg\+xml;generated-avatar=1,/i.test(String(url || "").trim());
}

export function isAllowedProfileImageFile(file) {
    const type = String(file?.type || "").toLowerCase();
    if (ALLOWED_PROFILE_IMAGE_MIME_TYPES.has(type)) return true;
    const name = String(file?.name || "").toLowerCase();
    return /\.(jpe?g|png|webp|gif)$/i.test(name);
}

export async function readFileAsDataUrl(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Impossible de lire ce fichier."));
        reader.readAsDataURL(file);
    });
}

export function computeCropSelectionFromState(state) {
    if (!state) return null;
    const scale = (state.renderWidth / state.naturalWidth) * state.zoom;
    const sourceSize = PROFILE_AVATAR_CROP_BOX_SIZE / scale;

    let sourceX = (state.naturalWidth / 2)
        + ((-state.offsetX - (PROFILE_AVATAR_CROP_BOX_SIZE / 2)) / scale);
    let sourceY = (state.naturalHeight / 2)
        + ((-state.offsetY - (PROFILE_AVATAR_CROP_BOX_SIZE / 2)) / scale);

    sourceX = Math.max(0, Math.min(state.naturalWidth - sourceSize, sourceX));
    sourceY = Math.max(0, Math.min(state.naturalHeight - sourceSize, sourceY));

    return {
        sourceX,
        sourceY,
        sourceSize,
        cropMeta: {
            x: sourceX / state.naturalWidth,
            y: sourceY / state.naturalHeight,
            sw: sourceSize / state.naturalWidth,
            sh: sourceSize / state.naturalHeight
        }
    };
}

export function getCropOutputMimeType(sourceMimeType = "") {
    if (sourceMimeType === "image/png") return "image/png";
    if (sourceMimeType === "image/jpeg" || sourceMimeType === "image/jpg") return "image/jpeg";
    if (sourceMimeType === "image/webp") return "image/webp";
    return "image/webp";
}

export function inferAvatarExtension(file) {
    const type = String(file?.type || "").toLowerCase();
    if (type === "image/gif") return "gif";
    if (type === "image/png") return "png";
    if (type === "image/jpeg") return "jpg";
    return "webp";
}

export async function generatedAvatarDataUrlToFile(dataUrl, fileName = `avatar-generated-${Date.now()}.png`) {
    const value = String(dataUrl || "").trim();
    if (!isGeneratedInitialsAvatarUrl(value)) {
        throw new Error("Avatar généré invalide.");
    }

    const image = await new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve(probe);
        probe.onerror = () => reject(new Error("Avatar généré corrompu."));
        probe.src = value;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Impossible de préparer l'avatar généré.");
    }

    context.clearRect(0, 0, 512, 512);
    context.drawImage(image, 0, 0, 512, 512);

    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png", 0.92));
    if (!pngBlob) {
        throw new Error("Conversion PNG impossible.");
    }
    return new File([pngBlob], fileName, { type: "image/png" });
}

export function getStoragePathFromPublicUrl(url) {
    if (!url || typeof url !== "string") return null;
    const marker = "/o/";
    const cleanUrl = stripAvatarCropMeta(url);
    const markerIndex = cleanUrl.indexOf(marker);
    if (markerIndex === -1) return null;
    const encodedPath = cleanUrl.slice(markerIndex + marker.length).split("?")[0] || "";
    if (!encodedPath) return null;
    return decodeURIComponent(encodedPath);
}
