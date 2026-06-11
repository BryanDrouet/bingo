import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    getAuth,
    EmailAuthProvider,
    GoogleAuthProvider,
    OAuthProvider,
    GithubAuthProvider,
    TwitterAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    fetchSignInMethodsForEmail,
    signInAnonymously,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut,
    updateProfile,
    updatePassword,
    deleteUser,
    reauthenticateWithPopup,
    reauthenticateWithCredential,
    linkWithPopup,
    linkWithCredential,
    unlink,
    onAuthStateChanged,
    browserLocalPersistence,
    setPersistence
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
    initializeFirestore,
    collection,
    doc,
    addDoc,
    getDocs,
    getDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    query,
    orderBy,
    where,
    limit
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
    getStorage,
    ref as storageRef,
    uploadBytes,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js";

const FIREBASE_CONFIG = window.__FIREBASE_CONFIG__ || {};

const REQUIRED_FIREBASE_KEYS = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId"
];

function getMissingFirebaseKeys(config) {
    if (!config || typeof config !== "object") return [...REQUIRED_FIREBASE_KEYS];
    return REQUIRED_FIREBASE_KEYS.filter(k => !config[k]);
}

const missingFirebaseKeys = getMissingFirebaseKeys(FIREBASE_CONFIG);
if (missingFirebaseKeys.length) {
    const app = document.getElementById("app");
    const expectedConfigFile = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? "js/firebase-config.local.js (ou fallback local js/firebase-config.js)"
        : "js/firebase-config.js";
    if (app) {
        app.innerHTML = `
            <div class="view view-login">
                <header class="app-header">
                    <div class="header-left">
                        <div class="header-title-group">
                            <span class="header-main-text">Bingo</span>
                        </div>
                    </div>
                </header>
                <div class="login-body">
                    <div class="login-card">
                        <h1>Configuration manquante</h1>
                        <p>La configuration Firebase n'est pas chargee. Verifiez le fichier ${expectedConfigFile}.</p>
                    </div>
                </div>
            </div>
        `;
    }
    throw new Error(`Firebase config missing keys: ${missingFirebaseKeys.join(", ")}`);
}

const MAX_BINGOS = 50;

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const storage = getStorage(firebaseApp);
const db = initializeFirestore(firebaseApp, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});

setPersistence(auth, browserLocalPersistence).catch(() => {});

let currentUser = null;
let saveTimer = null;
let activeGameId = null;
let liveMarkedCells = [];
let hasShownWinModal = false;
let hasShownFinalWinModal = false;
let currentViewState = null;
let dashboardAllBingos = [];
let dashboardSearchDebounceTimer = null;
let dashboardSearchMediaQuery = null;
let themeTransitionTimeout = null;
let dashboardCategoryRegistry = { byKey: {}, list: [], colorByName: {} };
const HEADER_TRANSITION_MS = 180;
const VIEW_STATE_STORAGE_KEY = "bingo-view-state";
const CREATE_DRAFT_STORAGE_KEY = "bingo-create-draft";
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
const MAX_PROFILE_IMAGE_FILE_BYTES = 6 * 1024 * 1024;
const PROFILE_AVATAR_OUTPUT_SIZE = 512;
const PROFILE_AVATAR_CROP_BOX_SIZE = 180;
const PROFILE_AVATAR_MIN_ZOOM = 1;
const PROFILE_AVATAR_MAX_ZOOM = 3;
const PROFILE_CROPPER_TRANSITION_MS = 180;
const AVATAR_CROP_HASH_MARKER = "#avatarCrop=";
const ALLOWED_PROFILE_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
]);
let pendingProfilePhotoFile = null;
let pendingProfilePhotoObjectUrl = "";
let pendingProfilePhotoCropState = null;
let pendingProfilePhotoCropMeta = null;
let profileCropperCloseTimer = null;
let guestAvatarGenerationInFlight = false;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function stripAvatarCropMeta(url) {
    if (!url || typeof url !== "string") return "";
    const markerIndex = url.indexOf(AVATAR_CROP_HASH_MARKER);
    return markerIndex === -1 ? url : url.slice(0, markerIndex);
}

function parseAvatarCropMeta(url) {
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

function appendAvatarCropMeta(url, cropMeta) {
    const cleanUrl = stripAvatarCropMeta(url);
    if (!cropMeta) return cleanUrl;
    return `${cleanUrl}${AVATAR_CROP_HASH_MARKER}${encodeURIComponent(JSON.stringify(cropMeta))}`;
}

function buildAvatarCropInlineStyle(cropMeta) {
    if (!cropMeta) return "";
    const widthPct = (100 / cropMeta.sw).toFixed(5);
    const heightPct = (100 / cropMeta.sh).toFixed(5);
    const leftPct = (-(cropMeta.x / cropMeta.sw) * 100).toFixed(5);
    const topPct = (-(cropMeta.y / cropMeta.sh) * 100).toFixed(5);
    return `--avatar-crop-w:${widthPct}%;--avatar-crop-h:${heightPct}%;--avatar-crop-x:${leftPct}%;--avatar-crop-y:${topPct}%;`;
}

function renderAvatarImage(url, altText, imageClass, { id = "", hostClass = "" } = {}) {
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

function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readStoredJson(key) {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function writeStoredJson(key, value) {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

function removeStoredItem(key) {
    try {
        sessionStorage.removeItem(key);
    } catch {}
}

function setCurrentViewState(nextState) {
    currentViewState = {
        ...(currentViewState || {}),
        ...nextState,
        scrollY: 0
    };
    writeStoredJson(VIEW_STATE_STORAGE_KEY, currentViewState);
}

function persistCurrentScrollPosition() {
    if (!currentViewState) return;
    currentViewState = {
        ...currentViewState,
        scrollY: window.scrollY || 0
    };
    writeStoredJson(VIEW_STATE_STORAGE_KEY, currentViewState);
}

function restoreScrollPosition(scrollY = 0) {
    if (!scrollY) return;
    window.requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, left: 0, behavior: "auto" });
    });
}

function clearPersistedAppState() {
    currentViewState = null;
    removeStoredItem(VIEW_STATE_STORAGE_KEY);
    removeStoredItem(CREATE_DRAFT_STORAGE_KEY);
}

function readCreateDraft(editId) {
    const draft = readStoredJson(CREATE_DRAFT_STORAGE_KEY);
    if (!draft) return null;
    return (draft.editId || null) === (editId || null) ? draft : null;
}

function saveCreateDraft(editId) {
    const size = parseInt(document.getElementById("f-size")?.value, 10) || 3;
    const cells = Array.from({ length: size * size }, (_, i) => document.getElementById(`cell-${i}`)?.value || "");
    const categoryValue = getCreateCategoryValue();
    const categoryColor = getCreateCategoryColorValue();
    const categoryPattern = getCreateCategoryPatternValue();

    writeStoredJson(CREATE_DRAFT_STORAGE_KEY, {
        editId: editId || null,
        title: document.getElementById("f-title")?.value || "",
        category: categoryValue || "",
        categoryColor,
        categoryPattern,
        size,
        cells
    });
}

function getCreateCategoryValue() {
    const select = document.getElementById("f-category-select");
    if (!select) return document.getElementById("f-category")?.value || "";
    if (select.value !== "__new__") return select.value || "";
    return document.getElementById("f-category-new")?.value || "";
}

function getCreateCategoryColorValue() {
    return normalizeHexColor(document.getElementById("f-category-color")?.value, "#CC0000");
}

function getCreateCategoryPatternValue() {
    return normalizeCategoryPatternKey(document.getElementById("f-category-pattern")?.value, "none");
}

function clearCreateDraft(editId = null) {
    const draft = readStoredJson(CREATE_DRAFT_STORAGE_KEY);
    if (!draft || (draft.editId || null) !== (editId || null)) return;
    removeStoredItem(CREATE_DRAFT_STORAGE_KEY);
}

function persistCreateDraftIfNeeded() {
    if (currentViewState?.name !== "create") return;
    saveCreateDraft(currentViewState.editId || null);
}

function getViewContentTargets(root = document) {
    return [...root.querySelectorAll(".view > :not(.app-header)")];
}

function animateElementsIn(elements) {
    if (!elements.length || prefersReducedMotion()) return;
    elements.forEach(element => {
        element.classList.remove("ui-fade-leave", "ui-fade-enter", "ui-fade-enter-active");
        element.classList.add("ui-fade-enter");
    });

    requestAnimationFrame(() => {
        elements.forEach(element => {
            element.classList.add("ui-fade-enter-active");
        });
    });

    window.setTimeout(() => {
        elements.forEach(element => {
            element.classList.remove("ui-fade-enter", "ui-fade-enter-active");
        });
    }, HEADER_TRANSITION_MS + 40);
}

function animateElementIn(element) {
    if (!element) return;
    animateElementsIn([element]);
}

async function animateCurrentHeaderOut() {
    const header = document.querySelector(".app-header");
    if (!header || prefersReducedMotion()) return;
    header.classList.remove("app-header--enter", "app-header--enter-active");
    header.classList.add("app-header--leave");
}

function animateNewHeaderIn() {
    const header = document.querySelector(".app-header");
    if (!header || prefersReducedMotion()) return;
    header.classList.add("app-header--enter");
    requestAnimationFrame(() => {
        header.classList.add("app-header--enter-active");
    });
    window.setTimeout(() => {
        header.classList.remove("app-header--enter", "app-header--enter-active");
    }, HEADER_TRANSITION_MS + 40);
}

async function animateCurrentViewOut() {
    if (prefersReducedMotion()) return;
    animateCurrentHeaderOut();
    getViewContentTargets().forEach(element => {
        element.classList.remove("ui-fade-enter", "ui-fade-enter-active");
        element.classList.add("ui-fade-leave");
    });
    await wait(HEADER_TRANSITION_MS);
}

function animateNewViewIn() {
    if (prefersReducedMotion()) return;
    animateNewHeaderIn();
    animateElementsIn(getViewContentTargets());
}

async function replaceAppMarkup(markup, { animateOut = false, animateIn = true } = {}) {
    const app = document.getElementById("app");
    if (!app) return;
    if (animateOut) await animateCurrentViewOut();
    app.innerHTML = markup;
    if (animateIn) animateNewViewIn();
}

async function navigateWithHeader(renderFn) {
    persistCurrentScrollPosition();
    await animateCurrentViewOut();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return renderFn();
}

function isModifiedClick(event) {
    return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function isLegalPagePath(pathname) {
    return pathname.startsWith("/mentions-legales/") ||
        pathname.startsWith("/politique-confidentialite/") ||
        pathname.startsWith("/suppression-donnees-utilisateur/") ||
        pathname.startsWith("/conditions-de-service/");
}

function bindCrossPageHeaderTransitions() {
    document.addEventListener("click", async event => {
        const link = event.target.closest("a[href]");
        if (!link || isModifiedClick(event) || link.target === "_blank" || link.hasAttribute("download")) return;

        const url = new URL(link.href, window.location.origin);
        if (url.origin !== window.location.origin || !isLegalPagePath(url.pathname)) return;

        event.preventDefault();
        persistCurrentScrollPosition();
        await animateCurrentViewOut();
        window.location.href = url.href;
    });
}

function getAppModalElements() {
    return {
        root: document.getElementById("app-modal"),
        title: document.getElementById("app-modal-title"),
        message: document.getElementById("app-modal-message"),
        close: document.getElementById("app-modal-close"),
        cancel: document.getElementById("app-modal-cancel"),
        confirm: document.getElementById("app-modal-confirm")
    };
}

function showAppModal({ title, message, confirmText = "Confirmer", cancelText = "Annuler", confirmVariant = "primary", hideCancel = false }) {
    const modal = getAppModalElements();
    if (!modal.root || !modal.title || !modal.message || !modal.close || !modal.cancel || !modal.confirm) {
        return Promise.resolve(false);
    }

    modal.title.textContent = title;
    modal.message.textContent = message;
    modal.confirm.textContent = confirmText;
    modal.cancel.textContent = cancelText;
    modal.cancel.classList.toggle("hidden", hideCancel);
    modal.confirm.className = `btn btn--${confirmVariant}`;
    modal.root.classList.remove("hidden");

    initIcons();

    return new Promise(resolve => {
        const closeWith = result => {
            modal.root.classList.add("hidden");
            modal.confirm.removeEventListener("click", onConfirm);
            modal.cancel.removeEventListener("click", onCancel);
            modal.close.removeEventListener("click", onClose);
            modal.root.removeEventListener("click", onBackdrop);
            resolve(result);
        };

        const onConfirm = () => closeWith(true);
        const onCancel = () => closeWith(false);
        const onClose = () => closeWith(false);
        const onBackdrop = e => {
            if (e.target === modal.root) closeWith(false);
        };

        modal.confirm.addEventListener("click", onConfirm);
        modal.cancel.addEventListener("click", onCancel);
        modal.close.addEventListener("click", onClose);
        modal.root.addEventListener("click", onBackdrop);
        modal.confirm.focus();
    });
}

function initIcons() {
    if (window.lucide) window.lucide.createIcons();
}

function updateYears() {
    document.querySelectorAll(".dyn-year").forEach(el => {
        el.textContent = new Date().getFullYear();
    });
}

function showToast(message, type = "info", options = {}) {
    if (window.Notify && typeof window.Notify.show === "function") {
        return window.Notify.show(message, type, options);
    }
    console.warn("Système de notifications indisponible:", message);
}

function initCookieBanner() {
    const banner = document.getElementById("cookie-banner");
    if (!banner) return;
    if (!localStorage.getItem("bingo-cookie-consent")) banner.classList.remove("hidden");

    document.getElementById("cookie-accept")?.addEventListener("click", () => {
        localStorage.setItem("bingo-cookie-consent", "accepted");
        banner.classList.add("hidden");
    });
    document.getElementById("cookie-decline")?.addEventListener("click", () => {
        localStorage.setItem("bingo-cookie-consent", "declined");
        banner.classList.add("hidden");
        showToast("Certaines fonctionnalités peuvent être limitées.", "warning");
    });
}

function bingoCollRef() {
    return collection(db, `users/${currentUser.uid}/bingos`);
}

function bingoDocRef(id) {
    return doc(db, `users/${currentUser.uid}/bingos/${id}`);
}

async function updateCategoryColorForName(categoryName, nextColor) {
    const targets = dashboardAllBingos.filter(
        bingo => normalizeCategoryName(bingo.category) === normalizeCategoryName(categoryName)
    );

    await Promise.all(targets.map(bingo => updateDoc(bingoDocRef(bingo.id), {
        categoryColor: nextColor,
        updatedAt: serverTimestamp()
    })));

    dashboardAllBingos = dashboardAllBingos.map(bingo =>
        normalizeCategoryName(bingo.category) === normalizeCategoryName(categoryName)
            ? { ...bingo, categoryColor: nextColor }
            : bingo
    );
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
}

async function updateCategoryPatternForName(categoryName, nextPattern, nextPatternZoom = 1) {
    const normalizedZoom = normalizePatternZoom(nextPatternZoom, 1, nextPattern);
    const targets = dashboardAllBingos.filter(
        bingo => normalizeCategoryName(bingo.category) === normalizeCategoryName(categoryName)
    );

    await Promise.all(targets.map(bingo => updateDoc(bingoDocRef(bingo.id), {
        categoryPattern: nextPattern,
        categoryPatternZoom: normalizedZoom,
        updatedAt: serverTimestamp()
    })));

    dashboardAllBingos = dashboardAllBingos.map(bingo =>
        normalizeCategoryName(bingo.category) === normalizeCategoryName(categoryName)
            ? { ...bingo, categoryPattern: nextPattern, categoryPatternZoom: normalizedZoom }
            : bingo
    );
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
}

async function renameCategoryForName(oldName, newName) {
    const oldKey = normalizeCategoryName(oldName);
    const targets = dashboardAllBingos.filter(
        bingo => normalizeCategoryName(bingo.category) === oldKey
    );

    await Promise.all(targets.map(bingo => updateDoc(bingoDocRef(bingo.id), {
        category: newName,
        updatedAt: serverTimestamp()
    })));

    dashboardAllBingos = dashboardAllBingos.map(bingo =>
        normalizeCategoryName(bingo.category) === oldKey
            ? { ...bingo, category: newName }
            : bingo
    );
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
}

async function purgeUserBingos() {
    const all = await fetchBingos();
    await Promise.all(all.map(bingo => deleteDoc(bingoDocRef(bingo.id))));
    dashboardAllBingos = [];
    dashboardCategoryRegistry = { byKey: {}, list: [], colorByName: {} };
}

function isBlockedByClient(err) {
    const msg = (err && (err.message || err.code) || "").toString().toLowerCase();
    return msg.includes("blocked") || msg.includes("network") || msg.includes("unavailable") || msg.includes("failed to fetch");
}

function extractErrorCode(err) {
    const code = String(err?.code || "").trim();
    if (!code) return "unknown";
    return code.includes("/") ? code.split("/").pop() : code;
}

function getFriendlyErrorDetails(err, context = "opération") {
    const code = extractErrorCode(err);
    const detailsByCode = {
        "permission-denied": {
            userMessage: "Accès refusé pour enregistrer ce bingo.",
            cause: "Les règles Firestore bloquent cette écriture.",
            action: "Vérifie les règles Firestore pour users/{uid}/bingos et que tu es bien connecté au bon compte."
        },
        "unauthenticated": {
            userMessage: "Vous devez être connecté pour enregistrer.",
            cause: "Session Firebase absente ou expirée.",
            action: "Reconnecte-toi puis réessaie."
        },
        unavailable: {
            userMessage: "Service temporairement indisponible.",
            cause: "Firestore n'est pas joignable pour le moment.",
            action: "Réessaie dans quelques secondes."
        },
        "network-request-failed": {
            userMessage: "Échec réseau pendant l'enregistrement.",
            cause: "Connexion interrompue ou requête bloquée.",
            action: "Vérifie la connexion et désactive un éventuel bloqueur pour ce site."
        },
        blocked: {
            userMessage: "Requête bloquée par le navigateur ou une extension.",
            cause: "Un bloqueur empêche l'appel Firestore.",
            action: "Autorise ce site dans le bloqueur puis recharge la page."
        },
        "failed-precondition": {
            userMessage: "Précondition Firestore non satisfaite.",
            cause: "Index manquant ou configuration incomplète.",
            action: "Ouvre la console Firebase pour créer l'index proposé si nécessaire."
        },
        "resource-exhausted": {
            userMessage: "Quota Firestore atteint.",
            cause: "Limite de lecture/écriture dépassée.",
            action: "Attends le reset du quota ou augmente le plan."
        }
    };

    const fallback = {
        userMessage: `Erreur pendant ${context}.`,
        cause: err?.message || "Cause non précisée.",
        action: "Consulte la console pour le détail technique."
    };

    const mapped = detailsByCode[code] || (isBlockedByClient(err) ? detailsByCode.blocked : null) || fallback;
    return {
        code,
        ...mapped,
        rawMessage: String(err?.message || "")
    };
}

function logStyledError(context, err, details, extra = {}) {
    const titleStyle = "background:#CC0000;color:#fff;padding:3px 8px;border-radius:6px;font-weight:900;";
    const keyStyle = "color:#790000;font-weight:800;";
    const valueStyle = "color:#111;";

    console.groupCollapsed(`%cBINGO ERREUR%c ${context}`, titleStyle, "color:#111;font-weight:800;");
    console.log("%cContexte:%c", keyStyle, valueStyle, context);
    console.log("%cCode:%c", keyStyle, valueStyle, details.code || "unknown");
    console.log("%cCause:%c", keyStyle, valueStyle, details.cause || "-");
    console.log("%cAction conseillée:%c", keyStyle, valueStyle, details.action || "-");
    if (details.rawMessage) {
        console.log("%cMessage brut:%c", keyStyle, valueStyle, details.rawMessage);
    }
    if (Object.keys(extra).length) {
        console.log("%cDonnées utiles:%c", keyStyle, valueStyle, extra);
    }
    console.error(err);
    console.groupEnd();
}

function getAuthErrorDetails(err, context = "la connexion", providerLabel = null) {
    const code = extractErrorCode(err);
    const isEmailPasswordProvider = providerLabel === "email/password" || providerLabel === "password";
    const detailsByCode = {
        "invalid-credential": {
            userMessage: "Identifiants invalides.",
            cause: isEmailPasswordProvider
                ? "L'adresse e-mail n'est pas liée au mot de passe ou le mot de passe est incorrect."
                : providerLabel
                ? `Le fournisseur ${providerLabel} a refusé l'authentification ou n'a pas renvoyé de session valide.`
                : "Le fournisseur d'authentification a refusé l'identifiant ou le jeton reçu.",
            action: isEmailPasswordProvider
                ? "Si cette adresse est liée à Google/GitHub/X, connecte-toi avec ce fournisseur puis ajoute un mot de passe dans la page Compte."
                : "Vérifie le fournisseur activé, les domaines autorisés et le callback OAuth configuré dans X/Firebase."
        },
        "wrong-password": {
            userMessage: "Mot de passe incorrect.",
            cause: "Le mot de passe saisi ne correspond pas au compte Firebase.",
            action: "Réessaie avec le bon mot de passe ou utilise la réinitialisation."
        },
        "user-not-found": {
            userMessage: "Aucun compte ne correspond à cette adresse.",
            cause: "L'adresse e-mail n'existe pas dans Firebase Auth.",
            action: "Vérifie l'adresse saisie ou crée un compte."
        },
        "operation-not-allowed": {
            userMessage: "Cette méthode de connexion n'est pas activée.",
            cause: "Le fournisseur OAuth ou la connexion e-mail n'est pas autorisé dans Firebase Auth.",
            action: "Active la méthode correspondante dans Firebase Console > Authentication > Sign-in method."
        },
        "unauthorized-domain": {
            userMessage: "Domaine non autorisé.",
            cause: "Le domaine courant n'est pas listé dans les domaines autorisés Firebase.",
            action: "Ajoute le domaine du site dans Firebase Console > Authentication > Settings > Authorized domains."
        },
        "account-exists-with-different-credential": {
            userMessage: "Compte déjà lié à une autre méthode.",
            cause: "Firebase a trouvé un autre fournisseur déjà associé à cette adresse.",
            action: "Connecte-toi avec l'autre méthode puis associe le fournisseur voulu."
        },
        "email-already-in-use": {
            userMessage: "Adresse déjà utilisée.",
            cause: "Un compte existe déjà avec cette adresse e-mail.",
            action: "Connecte-toi avec une méthode existante ou utilise « Mot de passe oublié ? » si le compte a un mot de passe."
        },
        "provider-already-linked": {
            userMessage: "Ce fournisseur est déjà lié.",
            cause: "Le compte est déjà connecté à cette méthode d'authentification.",
            action: "Aucune action requise."
        },
        "credential-already-in-use": {
            userMessage: "Identifiants déjà utilisés.",
            cause: "Ces identifiants sont déjà liés à un autre compte Firebase.",
            action: "Connecte-toi à ce compte existant puis fusionne les données si nécessaire."
        },
        "requires-recent-login": {
            userMessage: "Reconnectez-vous pour continuer.",
            cause: "Cette action sensible nécessite une authentification récente.",
            action: "Reconnecte-toi puis réessaie."
        },
        "weak-password": {
            userMessage: "Mot de passe trop faible.",
            cause: "Le mot de passe ne respecte pas la longueur minimale.",
            action: "Utilise un mot de passe plus long (au moins 6 caractères)."
        },
        "popup-blocked": {
            userMessage: "Fenêtre de connexion bloquée.",
            cause: "Le navigateur ou une extension a bloqué la popup OAuth.",
            action: "Autorise les popups pour ce site puis réessaie."
        },
        "popup-closed-by-user": {
            userMessage: null,
            cause: "La popup a été fermée avant la validation.",
            action: "Relance simplement la connexion."
        }
    };

    const fallback = {
        userMessage: `Erreur pendant ${context}.`,
        cause: err?.message || "Cause non précisée.",
        action: "Consulte la console pour le détail technique."
    };

    const mapped = detailsByCode[code] || fallback;
    return {
        code,
        providerLabel,
        ...mapped,
        rawMessage: String(err?.message || "")
    };
}

function logAuthError(context, err, providerLabel = null, extra = {}) {
    const details = getAuthErrorDetails(err, context, providerLabel);
    const toastMessage = typeof extra?.toastMessage === "string"
        ? extra.toastMessage
        : details.userMessage;
    const detailsExtra = { ...extra };
    delete detailsExtra.toastMessage;

    if (toastMessage) {
        showToast(`${toastMessage} Voir la console (F12).`, "error");
    }
    logStyledError("Authentification", err, details, {
        provider: providerLabel || "unknown",
        ...detailsExtra
    });
}

function handleFirestoreError(err) {
    const details = getFriendlyErrorDetails(err, "l'accès aux données");
    if (isBlockedByClient(err)) {
        showToast("Accès à Firestore bloqué (bloqueur de pubs ?). Désactivez-le pour ce site.", "error");
    } else {
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
    }
    logStyledError("Firestore", err, details);
}

async function fetchBingos(filterCategory = null) {
    try {
        const constraints = [orderBy("createdAt", "desc"), limit(MAX_BINGOS)];
        if (filterCategory) constraints.unshift(where("category", "==", filterCategory));
        const snap = await getDocs(query(bingoCollRef(), ...constraints));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        handleFirestoreError(err);
        return [];
    }
}

async function fetchAllCategories() {
    try {
        const snap = await getDocs(query(bingoCollRef(), orderBy("createdAt", "desc"), limit(MAX_BINGOS)));
        return [...new Set(snap.docs.map(d => d.data().category).filter(Boolean))];
    } catch {
        return [];
    }
}

function buildDashboardRegex(searchQuery) {
    const query = (searchQuery || "").trim();
    if (!query) return { regex: null, error: null };

    const slashSyntax = query.match(/^\/(.*)\/([a-z]*)$/i);
    try {
        if (slashSyntax) {
            const pattern = slashSyntax[1];
            const rawFlags = slashSyntax[2] || "";
            const safeFlags = rawFlags.replace(/[gy]/g, "");
            return { regex: new RegExp(pattern, safeFlags), error: null };
        }
        return { regex: new RegExp(query, "i"), error: null };
    } catch {
        return { regex: null, error: "Regex invalide" };
    }
}

function getBingoSearchCorpus(bingo) {
    const title = bingo?.title || "";
    const category = bingo?.category || "";
    const cells = Array.isArray(bingo?.cells) ? bingo.cells.join("\n") : "";
    return `${category}\n${title}\n${cells}`;
}

function filterDashboardBingos(filterCategory = null, searchQuery = "") {
    const byCategory = filterCategory
        ? dashboardAllBingos.filter(b => (b.category || "") === filterCategory)
        : [...dashboardAllBingos];

    const { regex, error } = buildDashboardRegex(searchQuery);
    if (!regex || error) {
        return { results: byCategory, error };
    }

    return {
        results: byCategory.filter(b => regex.test(getBingoSearchCorpus(b))),
        error: null
    };
}

function updateDashboardSearchFeedback(error) {
    const input = document.getElementById("dashboard-search");
    if (!input) return;

    if (error) {
        input.classList.add("is-invalid");
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("title", "Regex invalide");
        return;
    }

    input.classList.remove("is-invalid");
    input.removeAttribute("aria-invalid");
    input.removeAttribute("title");
}

function applyDashboardFilters(filterCategory = null, searchQuery = "") {
    const { results, error } = filterDashboardBingos(filterCategory, searchQuery);
    updateDashboardSearchFeedback(error);
    renderBingoCards(results, { filterCategory, searchQuery, regexError: error });
}

function handleDashboardSearchInput() {
    const input = document.getElementById("dashboard-search");
    if (!input) return;

    const searchQuery = input.value || "";
    const activeCategory =
        document.querySelector("#category-filters .chip.is-active")?.dataset.cat
        ?? document.getElementById("category-filter-select")?.value
        ?? null;

    setCurrentViewState({
        name: "dashboard",
        filterCategory: activeCategory || null,
        searchQuery,
        bingoId: null,
        editId: null
    });

    if (dashboardSearchDebounceTimer) clearTimeout(dashboardSearchDebounceTimer);
    dashboardSearchDebounceTimer = window.setTimeout(() => {
        applyDashboardFilters(activeCategory || null, searchQuery);
    }, 120);
}

function updateDashboardSearchPlaceholder() {
    const input = document.getElementById("dashboard-search");
    if (!input) return;
    const isSmallScreen = window.matchMedia("(max-width: 620px)").matches;
    input.placeholder = isSmallScreen
        ? "Rechercher"
        : "Rechercher dans les titres, categories et contenus";
}


const OAUTH_PROVIDERS = {
    google: {
        label: "Google",
        providerId: "google.com",
        enabled: true,
        factory: () => {
            const provider = new GoogleAuthProvider();
            provider.setCustomParameters({ prompt: "select_account" });
            return provider;
        },
        icon: `<img src="/assets/google-favicon-2025.svg" alt="" class="provider-icon" aria-hidden="true">`
    },
    microsoft: {
        label: "Microsoft",
        providerId: "microsoft.com",
        enabled: false,
        unavailableLabel: "Bientot",
        factory: () => new OAuthProvider("microsoft.com"),
        icon: `<svg class="provider-icon" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>`
    },
    github: {
        label: "GitHub",
        providerId: "github.com",
        enabled: true,
        factory: () => new GithubAuthProvider(),
        icon: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"/></svg>`
    },
    twitter: {
        label: "X",
        providerId: "twitter.com",
        enabled: true,
        factory: () => new TwitterAuthProvider(),
        icon: `<svg class="provider-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.48 3.24H4.29z"/></svg>`
    }
};

const AUTH_PROVIDER_LABELS = {
    password: "mot de passe",
    "google.com": "Google",
    "github.com": "GitHub",
    "twitter.com": "X",
    "microsoft.com": "Microsoft"
};

function getProviderLabel(providerId) {
    return AUTH_PROVIDER_LABELS[providerId] || String(providerId || "").replace(/\.com$/i, "") || "inconnu";
}

function getProviderKeyById(providerId) {
    return Object.keys(OAUTH_PROVIDERS).find(key => OAUTH_PROVIDERS[key]?.providerId === providerId) || null;
}

function getProviderFactoryById(providerId) {
    const key = getProviderKeyById(providerId);
    return key ? OAUTH_PROVIDERS[key] : null;
}

function getDefaultProviderPhotoUrl(user = currentUser) {
    if (!user) return "";
    const providerPhoto = (user.providerData || []).find(item => typeof item?.photoURL === "string" && item.photoURL.trim());
    return providerPhoto?.photoURL?.trim() || "";
}

function getInitialsFromIdentity(displayName = "", email = "") {
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

function hashStringToInt(input = "") {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

function hslToRgb(h, s, l) {
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

function toHexColor(rgb) {
    const toHex = channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function getReadableTextColorFromRgb(rgb) {
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance > 0.62 ? "#111111" : "#FFFFFF";
}

function createGeneratedInitialsAvatarUrl({ displayName = "", email = "", uid = "", seed = "" } = {}) {
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

function isGeneratedInitialsAvatarUrl(url = "") {
    return /^data:image\/svg\+xml;generated-avatar=1,/i.test(String(url || "").trim());
}

function getLinkedProviderIds(user = currentUser) {
    return [...new Set((user?.providerData || []).map(entry => entry?.providerId).filter(Boolean))];
}

function hasPasswordProvider(user = currentUser) {
    return getLinkedProviderIds(user).includes("password");
}

function joinWithConjunction(values) {
    const items = [...new Set((values || []).filter(Boolean))];
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} et ${items[1]}`;
    return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

function formatAuthMethods(methods) {
    return joinWithConjunction((methods || []).map(getProviderLabel));
}

function buildEmailAuthConflictMessage(methods = [], mode = "signin") {
    const labels = formatAuthMethods(methods) || "un autre fournisseur";
    const hasPassword = methods.includes("password");

    if (mode === "signup") {
        if (hasPassword && methods.length === 1) {
            return "Cette adresse est déjà utilisée avec un mot de passe. Utilisez « Se connecter » ou « Mot de passe oublié ? ».";
        }
        if (hasPassword) {
            return `Cette adresse est déjà liée à ${labels} et à un mot de passe. Utilisez une méthode existante pour vous connecter puis gérez le mot de passe dans la page Compte.`;
        }
        return `Cette adresse est déjà liée à ${labels}. Connectez-vous avec ce fournisseur puis ajoutez un mot de passe dans la page Compte.`;
    }

    if (mode === "signin" && methods.length && !hasPassword) {
        return `Cette adresse est déjà liée à ${labels}, pas à un mot de passe. Utilisez ${labels} pour vous connecter, puis ajoutez un mot de passe dans la page Compte.`;
    }

    return null;
}

async function getSignInMethodsForEmailAddress(email) {
    try {
        return await fetchSignInMethodsForEmail(auth, email);
    } catch {
        return [];
    }
}

let emailAuthMode = "signin";

function getAuthErrorMessage(code, context = "la connexion") {
    const map = {
        "auth/popup-closed-by-user": null,
        "auth/cancelled-popup-request": null,
        "auth/invalid-email": "Adresse e-mail invalide.",
        "auth/user-disabled": "Ce compte a été désactivé.",
        "auth/user-not-found": "Aucun compte ne correspond à cette adresse.",
        "auth/wrong-password": "Mot de passe incorrect.",
        "auth/invalid-credential": "Identifiants incorrects.",
        "auth/email-already-in-use": "Un compte existe déjà avec cette adresse.",
        "auth/weak-password": "Mot de passe trop faible (6 caractères minimum).",
        "auth/missing-password": "Veuillez saisir un mot de passe.",
        "auth/too-many-requests": "Trop de tentatives. Réessayez plus tard.",
        "auth/network-request-failed": "Échec réseau. Vérifiez votre connexion.",
        "auth/account-exists-with-different-credential": "Un compte existe déjà avec une autre méthode pour cette adresse.",
        "auth/operation-not-allowed": "Cette méthode de connexion n'est pas activée.",
        "auth/unauthorized-domain": "Domaine non autorisé dans la configuration Firebase."
    };
    if (code in map) return map[code];
    return `Erreur pendant ${context}. Réessayez.`;
}

async function renderLoginView() {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "login" });
    emailAuthMode = "signin";

    const providerButtons = Object.entries(OAUTH_PROVIDERS).map(([key, meta]) => `
        <button
            type="button"
            class="login-provider-btn${meta.enabled === false ? " login-provider-btn--soon" : ""}"
            data-provider="${key}"
            aria-label="Se connecter avec ${meta.label}"
            ${meta.enabled === false ? `disabled aria-disabled="true" title="Connexion ${meta.label} bientot disponible"` : ""}
        >
            ${meta.icon}
            <span>${meta.label}</span>
            ${meta.enabled === false ? `<span class="provider-badge-soon" aria-hidden="true">${meta.unavailableLabel || "Bientot"}</span>` : ""}
        </button>
    `).join("");

    await replaceAppMarkup(`
        <div class="view view-login">
            <header class="app-header">
                <div class="header-left">
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        ${buildHeaderTagMarkup("Interactif")}
                    </div>
                </div>
            </header>
            <div class="login-body">
                <div class="login-card login-card--auth">
                    <h1>Bienvenue</h1>
                    <p>Choisissez une méthode pour créer et gérer vos grilles de bingo.</p>

                    <div class="login-providers" role="group" aria-label="Connexion via un fournisseur">
                        ${providerButtons}
                    </div>

                    <div class="login-divider"><span>ou par e-mail</span></div>

                    <form id="email-auth-form" class="login-form" novalidate>
                        <div class="form-group">
                            <label for="login-email">Adresse e-mail</label>
                            <input id="login-email" name="loginEmail" type="email" autocomplete="email" spellcheck="false" placeholder="vous@exemple.com" required>
                        </div>
                        <div class="form-group">
                            <label for="login-password">Mot de passe</label>
                            <input id="login-password" name="loginPassword" type="password" autocomplete="current-password" minlength="6" placeholder="6 caractères minimum" required>
                        </div>
                        <button type="submit" id="email-submit-btn" class="btn btn--primary btn--block">Se connecter</button>
                        <div class="login-form-links">
                            <button type="button" id="toggle-email-mode" class="link">Créer un compte</button>
                            <button type="button" id="reset-password-btn" class="link">Mot de passe oublié ?</button>
                        </div>
                    </form>

                    <div class="login-divider"><span>autres options</span></div>

                    <button type="button" id="anon-signin-btn" class="btn btn--ghost-dark btn--block">
                        <i data-lucide="user" aria-hidden="true"></i>
                        Continuer en invité
                    </button>
                </div>
            </div>
        </div>
    `);

    document.querySelectorAll(".login-provider-btn").forEach(btn => {
        btn.addEventListener("click", () => handleOAuthSignIn(btn.dataset.provider));
    });
    document.getElementById("email-auth-form")?.addEventListener("submit", handleEmailAuth);
    document.getElementById("toggle-email-mode")?.addEventListener("click", toggleEmailAuthMode);
    document.getElementById("reset-password-btn")?.addEventListener("click", handlePasswordReset);
    document.getElementById("anon-signin-btn")?.addEventListener("click", handleAnonymousSignIn);

    updateYears();
    initIcons();
}

async function trySignIn(action, provider) {
    try {
        await signInWithPopup(auth, provider);
        return true;
    } catch (err) {
        const code = err && err.code;
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
            return false;
        }
        if (
            code === "auth/popup-blocked" ||
            code === "auth/operation-not-supported-in-this-environment" ||
            code === "auth/web-storage-unsupported" ||
            code === "auth/internal-error"
        ) {
            try {
                await signInWithRedirect(auth, provider);
                return true;
            } catch (e) {
                logAuthError(action, e, provider?.providerId || null, { mode: "redirect" });
                return false;
            }
        }
        logAuthError(action, err, provider?.providerId || null, { mode: "popup" });
        return false;
    }
}

async function handleOAuthSignIn(key) {
    const meta = OAUTH_PROVIDERS[key];
    if (!meta) return;
    if (meta.enabled === false) {
        showToast(`Connexion ${meta.label} bientot disponible.`, "info");
        return;
    }
    const btn = document.querySelector(`.login-provider-btn[data-provider="${key}"]`);
    if (btn) btn.disabled = true;
    let settled = false;
    const reenableOnFocus = () => {
        if (!settled && btn) btn.disabled = false;
    };
    window.addEventListener("focus", reenableOnFocus, { once: true });

    const ok = await trySignIn(`la connexion ${meta.label}`, meta.factory());
    settled = true;
    window.removeEventListener("focus", reenableOnFocus);

    if (!ok && btn) btn.disabled = false;
}

function toggleEmailAuthMode() {
    emailAuthMode = emailAuthMode === "signin" ? "signup" : "signin";
    const submit = document.getElementById("email-submit-btn");
    const toggle = document.getElementById("toggle-email-mode");
    const password = document.getElementById("login-password");
    if (emailAuthMode === "signup") {
        if (submit) submit.textContent = "Créer un compte";
        if (toggle) toggle.textContent = "J'ai déjà un compte";
        if (password) password.setAttribute("autocomplete", "new-password");
    } else {
        if (submit) submit.textContent = "Se connecter";
        if (toggle) toggle.textContent = "Créer un compte";
        if (password) password.setAttribute("autocomplete", "current-password");
    }
}

async function handleEmailAuth(e) {
    e.preventDefault();
    const emailInput = document.getElementById("login-email");
    const passwordInput = document.getElementById("login-password");
    const submit = document.getElementById("email-submit-btn");
    const email = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";

    if (!email) {
        showToast("Veuillez saisir votre adresse e-mail.", "warning");
        emailInput?.focus();
        return;
    }
    if (password.length < 6) {
        showToast("Le mot de passe doit contenir au moins 6 caractères.", "warning");
        passwordInput?.focus();
        return;
    }

    if (submit) submit.disabled = true;
    try {
        if (emailAuthMode === "signup") {
            await createUserWithEmailAndPassword(auth, email, password);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        const code = extractErrorCode(err);
        let toastMessage;

        if (email && (code === "invalid-credential" || code === "email-already-in-use")) {
            const methods = await getSignInMethodsForEmailAddress(email);
            toastMessage = buildEmailAuthConflictMessage(methods, emailAuthMode);
            if (!toastMessage && code === "invalid-credential" && methods.includes("password")) {
                toastMessage = "Adresse e-mail ou mot de passe incorrect.";
            }
        }

        logAuthError("la connexion e-mail", err, "email/password", {
            mode: emailAuthMode,
            toastMessage
        });
        if (submit) submit.disabled = false;
    }
}

async function handlePasswordReset() {
    const email = (document.getElementById("login-email")?.value || "").trim();
    if (!email) {
        showToast("Saisissez votre adresse e-mail puis cliquez sur « Mot de passe oublié ».", "warning");
        document.getElementById("login-email")?.focus();
        return;
    }
    try {
        await sendPasswordResetEmail(auth, email);
        showToast("E-mail de réinitialisation envoyé. Vérifiez votre boîte de réception.", "success");
    } catch (err) {
        const message = getAuthErrorMessage(err?.code, "l'envoi de l'e-mail");
        if (message) showToast(message, "error");
    }
}

async function handleAnonymousSignIn() {
    const confirmed = await showAppModal({
        title: "Continuer en invité",
        message: "En mode invité, vos bingos sont liés uniquement à cet appareil et à ce navigateur. Si vous changez d'appareil, videz le cache ou la mémoire du navigateur, vos données ne pourront pas être récupérées ni transférées. Pour conserver vos bingos, préférez une connexion avec un compte.",
        confirmText: "Continuer en invité",
        cancelText: "Annuler"
    });
    if (!confirmed) return;
    const btn = document.getElementById("anon-signin-btn");
    if (btn) btn.disabled = true;
    try {
        await signInAnonymously(auth);
    } catch (err) {
        const message = getAuthErrorMessage(err?.code, "la connexion invité");
        if (message) showToast(message, "error");
        if (btn) btn.disabled = false;
    }
}

async function handleSignOut() {
    try {
        if (saveTimer) {
            clearTimeout(saveTimer);
            await saveMarkedCells(activeGameId, [...liveMarkedCells]);
        }
        clearPersistedAppState();
        await animateCurrentViewOut();
        await signOut(auth);
    } catch {
        showToast("Erreur lors de la déconnexion.", "error");
    }
}

function setupProfileMenu({ onAccount, onSignOut } = {}) {
    const menu = document.getElementById("profile-menu");
    const trigger = document.getElementById("account-btn");
    const dropdown = document.getElementById("profile-dropdown");
    if (!menu || !trigger || !dropdown) return;

    const closeMenu = () => {
        if (dropdown.hidden) return;
        dropdown.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onDocumentClick, true);
        document.removeEventListener("keydown", onKeyDown, true);
    };

    const openMenu = () => {
        if (!dropdown.hidden) return;
        dropdown.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        document.addEventListener("click", onDocumentClick, true);
        document.addEventListener("keydown", onKeyDown, true);
        dropdown.querySelector(".profile-dropdown-item")?.focus();
    };

    function onDocumentClick(event) {
        if (!menu.contains(event.target)) closeMenu();
    }

    function onKeyDown(event) {
        if (event.key === "Escape") {
            closeMenu();
            trigger.focus();
        }
    }

    trigger.addEventListener("click", () => {
        if (dropdown.hidden) openMenu();
        else closeMenu();
    });

    document.getElementById("menu-account-btn")?.addEventListener("click", () => {
        closeMenu();
        void onAccount?.();
    });
    document.getElementById("menu-signout-btn")?.addEventListener("click", () => {
        closeMenu();
        void onSignOut?.();
    });
}


async function renderDashboard(filterCategory = null, searchQuery = "") {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "dashboard", filterCategory: filterCategory || null, searchQuery: searchQuery || "", bingoId: null, editId: null });
    const dashboardSearchPlaceholder = window.matchMedia("(max-width: 620px)").matches
        ? "Rechercher"
        : "Rechercher dans les titres, categories et contenus";
    const avatarHtml = currentUser.photoURL
        ? renderAvatarImage(
            currentUser.photoURL,
            `Photo de profil de ${currentUser.displayName || "utilisateur"}`,
            "img img--avatar",
            { hostClass: "img-avatar-crop-host" }
        )
        : "";
    await replaceAppMarkup(`
        <div class="view view-dashboard">
            <header class="app-header">
                <div class="header-left">
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        ${buildHeaderTagMarkup("Interactif")}
                    </div>
                </div>
                <div class="header-right">
                    <div class="profile-menu" id="profile-menu">
                        <button type="button" id="account-btn" class="profile-trigger" aria-haspopup="true" aria-expanded="false" aria-controls="profile-dropdown" aria-label="Ouvrir le menu du profil">
                            ${avatarHtml}
                            <span class="user-display-name" aria-hidden="true">${currentUser.displayName || currentUser.email || (currentUser.isAnonymous ? "Invité" : "")}</span>
                            <i data-lucide="chevron-down" class="profile-caret" aria-hidden="true"></i>
                        </button>
                        <div class="profile-dropdown" id="profile-dropdown" role="menu" aria-label="Menu du profil" hidden>
                            <button type="button" id="menu-account-btn" class="profile-dropdown-item" role="menuitem">
                                <i data-lucide="user" aria-hidden="true"></i>
                                <span>Compte</span>
                            </button>
                            <button type="button" id="menu-signout-btn" class="profile-dropdown-item profile-dropdown-item--danger" role="menuitem">
                                <i data-lucide="log-out" aria-hidden="true"></i>
                                <span>Se déconnecter</span>
                            </button>
                        </div>
                    </div>
                </div>
            </header>
            <main class="dashboard-body">
                <div class="dashboard-toolbar">
                    <div class="category-filters" id="category-filters" role="group" aria-label="Filtrer par catégorie"></div>
                    <div class="category-select-wrap">
                        <label for="category-filter-select" class="sr-only">Filtrer par catégorie</label>
                        <select id="category-filter-select" class="category-select" aria-label="Filtrer par catégorie"></select>
                    </div>
                    <div class="dashboard-search" role="search">
                        <label for="dashboard-search" class="sr-only">Rechercher dans les bingos</label>
                        <input type="text" id="dashboard-search" class="dashboard-search-input" value="${searchQuery || ""}" placeholder="${dashboardSearchPlaceholder}" autocomplete="off" spellcheck="false">
                        <button type="button" id="clear-dashboard-search" class="btn btn--ghost-dark btn--sm">Effacer</button>
                    </div>
                    <button type="button" id="create-bingo-btn" class="btn btn--primary">Nouveau bingo</button>
                </div>
                <div class="bingo-cards-grid" id="bingo-list" aria-label="Vos grilles de bingo">
                    <div class="loading-state" style="grid-column:1/-1"><div class="loading-spinner"></div></div>
                </div>
            </main>
        </div>
    `);
    document.getElementById("create-bingo-btn")?.addEventListener("click", () => {
        void navigateWithHeader(() => renderCreateView());
    });
    setupProfileMenu({
        onAccount: () => navigateWithHeader(() => renderAccountView()),
        onSignOut: handleSignOut
    });
    document.getElementById("dashboard-search")?.addEventListener("input", handleDashboardSearchInput);
    if (dashboardSearchMediaQuery) {
        dashboardSearchMediaQuery.removeEventListener("change", updateDashboardSearchPlaceholder);
    }
    dashboardSearchMediaQuery = window.matchMedia("(max-width: 620px)");
    dashboardSearchMediaQuery.addEventListener("change", updateDashboardSearchPlaceholder);
    updateDashboardSearchPlaceholder();
    document.getElementById("clear-dashboard-search")?.addEventListener("click", () => {
        const input = document.getElementById("dashboard-search");
        if (!input) return;
        input.value = "";
        handleDashboardSearchInput();
        input.focus();
    });
    updateYears();
    initIcons();

    dashboardAllBingos = await fetchBingos();
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
    const categories = dashboardCategoryRegistry.list.map(entry => entry.name);
    renderCategoryFilters(categories, filterCategory);
    applyDashboardFilters(filterCategory, searchQuery);
}

function renderCategoryFilters(categories, active) {
    const el = document.getElementById("category-filters");
    const select = document.getElementById("category-filter-select");
    if (!el) return;
    const items = [
        `<button type="button" class="chip ${!active ? "is-active" : ""}" data-cat="">Tous</button>`,
        ...categories.map(c => `<button type="button" class="chip ${active === c ? "is-active" : ""}" data-cat="${c}">${c}</button>`)
    ];
    el.innerHTML = items.join("");

    if (select) {
        const options = [
            `<option value="" ${!active ? "selected" : ""}>Toutes les catégories</option>`,
            ...categories.map(c => `<option value="${c}" ${active === c ? "selected" : ""}>${c}</option>`)
        ];
        select.innerHTML = options.join("");
        select.onchange = () => changeFilter(select.value || null);
    }

    animateElementIn(el);
    el.querySelectorAll(".chip").forEach(btn => {
        btn.addEventListener("click", () => changeFilter(btn.dataset.cat || null));
    });
}

async function renderAccountView() {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "account", bingoId: null, editId: null, filterCategory: null, searchQuery: "" });
    resetPendingProfilePhotoState();

    const displayName = currentUser?.displayName || "";
    const photoUrl = currentUser?.photoURL || "";
    const defaultProviderPhotoUrl = getDefaultProviderPhotoUrl(currentUser);
    const email = currentUser?.email || "";
    const avatarFallbackInitial = (displayName || email || "U").charAt(0).toUpperCase();
    const isAnonymous = !!currentUser?.isAnonymous;
    const accountLabel = email || (isAnonymous ? "Session invité (locale à cet appareil)" : "Compte connecté");
    const anonymousBanner = isAnonymous ? `
                <section class="account-card account-card--warning" aria-labelledby="account-anon-title">
                    <h2 id="account-anon-title" class="form-section-title">Mode invité</h2>
                    <p class="form-required-note">Les données invité restent locales à cet appareil. Pour les conserver partout, connecte-toi avec un compte.</p>
                </section>
    ` : "";

    const linkedProviders = getLinkedProviderIds(currentUser);
    const oauthProviderIds = ["google.com", "github.com", "twitter.com", "microsoft.com"];
    const providerRowsMarkup = oauthProviderIds.map(providerId => {
        const providerMeta = getProviderFactoryById(providerId);
        const isLinked = linkedProviders.includes(providerId);
        const isUnavailable = !providerMeta || providerMeta.enabled === false;
        const canUnlink = linkedProviders.length > 1;
        const buttonDisabled = isAnonymous || (isLinked ? !canUnlink : isUnavailable);
        const badgeClass = isLinked ? "is-linked" : "is-unlinked";
        const badgeLabel = isLinked ? "Lié" : "Non lié";
        const buttonText = isLinked
            ? (canUnlink ? "Délier" : "Conserver")
            : (isUnavailable ? "Indisponible" : "Lier");
        const action = isLinked ? "unlink" : "link";

        return `
            <li class="account-connection-item">
                <div class="account-connection-meta">
                    <span class="account-connection-label">${escapeHtml(getProviderLabel(providerId))}</span>
                    <span class="account-connection-badge ${badgeClass}">${badgeLabel}</span>
                </div>
                <button type="button" class="btn btn--neutral btn--sm account-provider-action-btn" data-provider-id="${providerId}" data-provider-action="${action}" ${buttonDisabled ? "disabled" : ""}>${escapeHtml(buttonText)}</button>
            </li>
        `;
    }).join("");

    const linkedPassword = linkedProviders.includes("password");
    const passwordSectionMarkup = isAnonymous
        ? `<p class="form-required-note">Connectez-vous avec un compte pour lier des réseaux et gérer un mot de passe.</p>`
        : `
            <form id="account-password-form" class="account-form account-password-form" novalidate>
                <p class="form-required-note">${linkedPassword
                    ? "Modifiez votre mot de passe."
                    : "Ajoutez un mot de passe pour pouvoir vous connecter aussi par e-mail."}</p>
                <div class="form-row form-row-2">
                    ${email ? "" : `
                        <div class="form-group">
                            <label for="account-password-email">Adresse e-mail</label>
                            <input id="account-password-email" name="accountPasswordEmail" type="email" autocomplete="email" placeholder="vous@exemple.com" required>
                        </div>
                    `}
                    ${linkedPassword ? `
                        <div class="form-group">
                            <label for="account-password-current">Mot de passe actuel</label>
                            <input id="account-password-current" name="accountPasswordCurrent" type="password" autocomplete="current-password" minlength="6" placeholder="Mot de passe actuel" required>
                        </div>
                    ` : ""}
                    <div class="form-group">
                        <label for="account-password-next">${linkedPassword ? "Nouveau mot de passe" : "Mot de passe"}</label>
                        <input id="account-password-next" name="accountPasswordNext" type="password" autocomplete="new-password" minlength="6" placeholder="6 caractères minimum" required>
                    </div>
                    <div class="form-group">
                        <label for="account-password-confirm">Confirmer le mot de passe</label>
                        <input id="account-password-confirm" name="accountPasswordConfirm" type="password" autocomplete="new-password" minlength="6" placeholder="Confirmer le mot de passe" required>
                    </div>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn btn--primary">${linkedPassword ? "Mettre à jour le mot de passe" : "Définir un mot de passe"}</button>
                    ${email ? `<button type="button" id="account-password-reset-btn" class="btn btn--neutral">Envoyer un e-mail de réinitialisation</button>` : ""}
                </div>
            </form>
        `;

    await replaceAppMarkup(`
        <div class="view view-account">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-account-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour au tableau de bord">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        <span class="header-tag">Compte</span>
                    </div>
                </div>
            </header>

            <main class="account-body">
                ${anonymousBanner}
                <section class="account-card" aria-labelledby="account-profile-title">
                    <h1 id="account-profile-title" class="form-section-title">Profil</h1>
                    <form id="account-profile-form" class="account-form" novalidate>
                        <p class="form-required-note">Pseudo et photo synchronisés sur ton compte.</p>
                        <div class="account-avatar-row">
                            <button type="button" id="account-avatar-edit-btn" class="account-avatar-edit-btn" aria-label="Changer la photo de profil">
                                <span id="account-avatar-preview-wrap">
                                    ${photoUrl
                                        ? renderAvatarImage(
                                            photoUrl,
                                            `Photo de profil de ${displayName || "utilisateur"}`,
                                            "account-avatar",
                                            { id: "account-avatar-preview", hostClass: "account-avatar-crop-host" }
                                        )
                                        : `<span class="account-avatar account-avatar--fallback" id="account-avatar-preview" aria-hidden="true">${escapeHtml(avatarFallbackInitial)}</span>`}
                                </span>
                                <span class="account-avatar-edit-overlay" aria-hidden="true">
                                    <i data-lucide="pencil"></i>
                                </span>
                            </button>
                            <div class="account-avatar-copy">
                                <strong>Photo de profil</strong>
                                <p>Clique sur la photo pour changer (URL, image locale, GIF).</p>
                            </div>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label for="account-display-name">Pseudo</label>
                                <input id="account-display-name" name="accountDisplayName" type="text" maxlength="60" value="${escapeHtml(displayName)}" autocomplete="name" spellcheck="false" placeholder="Votre pseudo">
                            </div>
                        </div>
                        <input id="account-photo-url" name="accountPhotoUrl" type="hidden" value="${escapeHtml(photoUrl)}">
                        <p class="account-email">Compte connecté: ${escapeHtml(accountLabel)}</p>
                        <div class="form-actions">
                            <button type="submit" class="btn btn--primary">Enregistrer le profil</button>
                        </div>
                    </form>

                    <div id="account-photo-modal" class="account-photo-modal" hidden>
                        <div class="account-photo-modal-backdrop" data-close-photo-modal="true"></div>
                        <div class="account-photo-modal-content" role="dialog" aria-modal="true" aria-labelledby="account-photo-modal-title">
                            <div class="account-photo-modal-header">
                                <h3 id="account-photo-modal-title">Modifier la photo de profil</h3>
                                <button type="button" id="account-photo-modal-close" class="btn btn--ghost-dark btn--sm" aria-label="Fermer">Fermer</button>
                            </div>
                            <div class="form-group">
                                <label for="account-photo-url-modal">Photo via URL</label>
                                <input id="account-photo-url-modal" type="url" autocomplete="url" spellcheck="false" placeholder="https://...">
                                <p class="form-help">Lien direct http(s), y compris .gif.</p>
                            </div>
                            <div class="form-actions">
                                <button type="button" id="account-photo-url-apply" class="btn btn--neutral">Utiliser ce lien</button>
                                <button type="button" id="account-photo-default-btn" class="btn btn--neutral" ${defaultProviderPhotoUrl ? "" : "disabled"}>Photo par défaut</button>
                                <button type="button" id="account-photo-clear-btn" class="btn btn--neutral" ${photoUrl ? "" : "disabled"}>Retirer la photo</button>
                            </div>
                            <div class="form-group">
                                <label for="account-photo-file">Importer une photo</label>
                                <input id="account-photo-file" name="accountPhotoFile" type="file" accept="image/*" aria-describedby="account-photo-file-help">
                                <p id="account-photo-file-help" class="form-help">JPEG, PNG, WEBP, GIF. Max 6 Mo.</p>
                            </div>
                            <div id="account-photo-cropper" class="account-photo-cropper" hidden>
                                <div class="account-photo-crop-head">
                                    <strong>Recadrage carré</strong>
                                    <span>Déplace et zoome, puis applique.</span>
                                </div>
                                <div id="account-photo-crop-stage" class="account-photo-crop-stage" aria-label="Zone de recadrage">
                                    <img id="account-photo-crop-image" class="account-photo-crop-image" alt="Prévisualisation du recadrage">
                                    <div class="account-photo-crop-frame" aria-hidden="true"></div>
                                </div>
                                <div class="account-photo-crop-controls">
                                    <label for="account-photo-crop-zoom">Zoom</label>
                                    <input id="account-photo-crop-zoom" type="range" min="1" max="3" step="0.01" value="1">
                                    <div class="form-actions">
                                        <button type="button" id="account-photo-crop-reset" class="btn btn--neutral">Réinitialiser</button>
                                        <button type="button" id="account-photo-crop-cancel" class="btn btn--ghost-dark">Annuler</button>
                                        <button type="button" id="account-photo-crop-apply" class="btn btn--primary">Appliquer le recadrage</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="account-card" aria-labelledby="account-categories-title">
                    <h2 id="account-connections-title" class="form-section-title">Connexions et mot de passe</h2>
                    <p class="form-required-note">Liez vos comptes sociaux et gérez l'authentification par e-mail.</p>
                    <ul class="account-connections-list" aria-label="Fournisseurs liés au compte">
                        ${providerRowsMarkup}
                    </ul>
                    ${passwordSectionMarkup}
                </section>

                <section class="account-card" aria-labelledby="account-categories-title">
                    <h2 id="account-categories-title" class="form-section-title">Catégories</h2>
                    <p class="form-required-note">Renommez vos catégories et personnalisez leur couleur. Les modifications s'appliquent à tous les bingos concernés.</p>
                    <div id="account-category-manager" class="category-manager-panel account-category-manager" aria-label="Gestion des catégories"></div>
                </section>

                <section class="account-card account-card--danger" aria-labelledby="account-security-title">
                    <h2 id="account-security-title" class="form-section-title">Données et compte</h2>
                    <p class="form-required-note">Actions sensibles. Une confirmation est demandée avant exécution.</p>
                    <div class="form-actions account-danger-actions">
                        <button type="button" id="purge-data-btn" class="btn btn--danger">Purger toutes mes données Bingo</button>
                        <button type="button" id="delete-account-btn" class="btn btn--danger">Supprimer définitivement mon compte</button>
                    </div>
                </section>
            </main>
        </div>
    `);

    document.getElementById("back-account-btn")?.addEventListener("click", () => {
        resetPendingProfilePhotoState();
        void navigateWithHeader(() => renderDashboard());
    });
    document.getElementById("signout-account-btn")?.addEventListener("click", handleSignOut);
    document.getElementById("account-profile-form")?.addEventListener("submit", handleAccountProfileSubmit);

    const avatarEditBtn = document.getElementById("account-avatar-edit-btn");
    const photoModal = document.getElementById("account-photo-modal");
    const photoModalCloseBtn = document.getElementById("account-photo-modal-close");
    const photoModalUrlInput = document.getElementById("account-photo-url-modal");
    const photoDefaultBtn = document.getElementById("account-photo-default-btn");
    const photoClearBtn = document.getElementById("account-photo-clear-btn");
    const PHOTO_MODAL_TRANSITION_MS = 180;
    let photoModalCloseTimer = null;

    const updatePhotoActionButtonsState = () => {
        const currentPhoto = String(document.getElementById("account-photo-url")?.value || "").trim();
        const hasPhoto = Boolean(currentPhoto) || Boolean(pendingProfilePhotoFile);
        if (photoClearBtn) photoClearBtn.disabled = !hasPhoto;

        if (photoDefaultBtn) {
            const hasDefault = Boolean(defaultProviderPhotoUrl);
            photoDefaultBtn.disabled = !hasDefault || stripAvatarCropMeta(currentPhoto) === stripAvatarCropMeta(defaultProviderPhotoUrl);
        }
    };

    const openPhotoModal = () => {
        if (!photoModal) return;
        if (photoModalCloseTimer) {
            clearTimeout(photoModalCloseTimer);
            photoModalCloseTimer = null;
        }
        photoModal.classList.remove("is-closing");
        photoModal.hidden = false;
        requestAnimationFrame(() => {
            photoModal.classList.add("is-open");
        });
        if (photoModalUrlInput) {
            const currentPhotoUrl = String(document.getElementById("account-photo-url")?.value || "").trim();
            photoModalUrlInput.value = isGeneratedInitialsAvatarUrl(currentPhotoUrl) ? "" : currentPhotoUrl;
            photoModalUrlInput.focus();
        }
        updatePhotoActionButtonsState();
    };

    const closePhotoModal = () => {
        if (!photoModal) return;
        photoModal.classList.remove("is-open");
        photoModal.classList.add("is-closing");
        if (photoModalCloseTimer) clearTimeout(photoModalCloseTimer);
        photoModalCloseTimer = window.setTimeout(() => {
            photoModal.hidden = true;
            photoModal.classList.remove("is-closing");
            if (!pendingProfilePhotoCropState) togglePhotoCropper(false);
            photoModalCloseTimer = null;
        }, PHOTO_MODAL_TRANSITION_MS);
    };

    avatarEditBtn?.addEventListener("click", openPhotoModal);
    photoModalCloseBtn?.addEventListener("click", closePhotoModal);
    photoModal?.addEventListener("click", event => {
        if (event.target?.dataset?.closePhotoModal === "true") closePhotoModal();
    });
    if (photoModal && photoModal.dataset.boundEsc !== "1") {
        photoModal.addEventListener("keydown", event => {
            if (event.key === "Escape" && !photoModal.hidden) closePhotoModal();
        });
        photoModal.dataset.boundEsc = "1";
    }

    document.getElementById("account-photo-file")?.addEventListener("change", handleAccountPhotoFileChange);
    document.getElementById("account-photo-url-apply")?.addEventListener("click", () => {
        const nextUrl = String(document.getElementById("account-photo-url-modal")?.value || "").trim();
        if (nextUrl) {
            try {
                const parsed = new URL(nextUrl);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    throw new Error("URL invalide");
                }
                const hiddenPhotoInput = document.getElementById("account-photo-url");
                if (hiddenPhotoInput) hiddenPhotoInput.value = parsed.toString();
            } catch {
                showToast("URL de photo invalide.", "error");
                return;
            }
        } else {
            const hiddenPhotoInput = document.getElementById("account-photo-url");
            if (hiddenPhotoInput) hiddenPhotoInput.value = "";
        }
        clearPendingProfilePhotoSelection();
        togglePhotoCropper(false);
        updatePhotoActionButtonsState();
        updateAccountAvatarPreview();
        closePhotoModal();
    });
    document.getElementById("account-photo-default-btn")?.addEventListener("click", () => {
        if (!defaultProviderPhotoUrl) return;
        const photoField = document.getElementById("account-photo-url");
        if (photoField) photoField.value = defaultProviderPhotoUrl;
        if (photoModalUrlInput) photoModalUrlInput.value = defaultProviderPhotoUrl;
        clearPendingProfilePhotoSelection();
        togglePhotoCropper(false);
        updatePhotoActionButtonsState();
        updateAccountAvatarPreview();
        closePhotoModal();
    });
    document.getElementById("account-display-name")?.addEventListener("input", () => {
        const photoInput = String(document.getElementById("account-photo-url")?.value || "").trim();
        if (!photoInput) updateAccountAvatarPreview();
    });
    document.getElementById("account-photo-clear-btn")?.addEventListener("click", () => {
        const photoField = document.getElementById("account-photo-url");
        if (photoField) {
            const displayName = String(document.getElementById("account-display-name")?.value || currentUser?.displayName || "").trim();
            const email = String(currentUser?.email || "").trim();
            photoField.value = createGeneratedInitialsAvatarUrl({
                displayName,
                email,
                uid: String(currentUser?.uid || ""),
                seed: Date.now().toString(36)
            });
        }
        const modalUrlInput = document.getElementById("account-photo-url-modal");
        if (modalUrlInput) modalUrlInput.value = "";
        clearPendingProfilePhotoSelection();
        togglePhotoCropper(false);
        updatePhotoActionButtonsState();
        updateAccountAvatarPreview();
        showToast("Avatar généré automatiquement.", "info");
        closePhotoModal();
    });
    document.getElementById("account-photo-crop-zoom")?.addEventListener("input", event => {
        if (!pendingProfilePhotoCropState) return;
        const nextZoom = parseFloat(event.currentTarget?.value || "1");
        pendingProfilePhotoCropState.zoom = Number.isFinite(nextZoom) ? nextZoom : 1;
        clampPendingCropOffsets();
        renderPendingCropPreview();
    });
    document.getElementById("account-photo-crop-reset")?.addEventListener("click", resetPendingCropTransform);
    document.getElementById("account-photo-crop-cancel")?.addEventListener("click", () => {
        clearPendingProfilePhotoSelection();
        togglePhotoCropper(false);
        const photoInput = document.getElementById("account-photo-url");
        if (photoInput) photoInput.value = currentUser?.photoURL || "";
        const modalUrlInput = document.getElementById("account-photo-url-modal");
        if (modalUrlInput) modalUrlInput.value = photoInput?.value || "";
        updateAccountAvatarPreview();
        updatePhotoActionButtonsState();
    });
    document.getElementById("account-photo-crop-apply")?.addEventListener("click", handleApplyPendingCrop);
    setupPendingCropDrag();
    document.querySelectorAll(".account-provider-action-btn").forEach(button => {
        button.addEventListener("click", () => handleAccountProviderAction(button.dataset.providerId, button.dataset.providerAction));
    });
    document.getElementById("account-password-form")?.addEventListener("submit", handleAccountPasswordSubmit);
    document.getElementById("account-password-reset-btn")?.addEventListener("click", handleAccountPasswordResetFromAccount);
    document.getElementById("purge-data-btn")?.addEventListener("click", handlePurgeUserData);
    document.getElementById("delete-account-btn")?.addEventListener("click", handleDeleteAccount);

    dashboardAllBingos = await fetchBingos();
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
    renderCategoryManagerPanelIn("account-category-manager", dashboardCategoryRegistry);

    updateYears();
    initIcons();
}

function updateAccountAvatarPreview() {
    const wrap = document.getElementById("account-avatar-preview-wrap");
    if (!wrap) return;

    if (pendingProfilePhotoObjectUrl) {
        const displayName = String(document.getElementById("account-display-name")?.value || currentUser?.displayName || "").trim();
        wrap.innerHTML = renderAvatarImage(
            pendingProfilePhotoObjectUrl,
            `Photo de profil de ${displayName || "utilisateur"}`,
            "account-avatar",
            { id: "account-avatar-preview", hostClass: "account-avatar-crop-host" }
        );
        return;
    }

    const photoValue = String(document.getElementById("account-photo-url")?.value || "").trim();
    const displayName = String(document.getElementById("account-display-name")?.value || currentUser?.displayName || "").trim();
    const fallbackInitial = (displayName || currentUser?.email || "U").charAt(0).toUpperCase();

    if (photoValue) {
        wrap.innerHTML = renderAvatarImage(
            photoValue,
            `Photo de profil de ${displayName || "utilisateur"}`,
            "account-avatar",
            { id: "account-avatar-preview", hostClass: "account-avatar-crop-host" }
        );
        return;
    }

    wrap.innerHTML = `<div class="account-avatar account-avatar--fallback" id="account-avatar-preview" aria-hidden="true">${escapeHtml(fallbackInitial)}</div>`;
}

function revokePendingProfileObjectUrl() {
    if (!pendingProfilePhotoObjectUrl) return;
    URL.revokeObjectURL(stripAvatarCropMeta(pendingProfilePhotoObjectUrl));
    pendingProfilePhotoObjectUrl = "";
}

function clearPendingProfilePhotoSelection() {
    pendingProfilePhotoFile = null;
    pendingProfilePhotoCropState = null;
    pendingProfilePhotoCropMeta = null;
    revokePendingProfileObjectUrl();
}

function resetPendingProfilePhotoState() {
    clearPendingProfilePhotoSelection();
    togglePhotoCropper(false);
}

function togglePhotoCropper(visible) {
    const cropper = document.getElementById("account-photo-cropper");
    if (!cropper) return;
    if (visible) {
        if (profileCropperCloseTimer) {
            clearTimeout(profileCropperCloseTimer);
            profileCropperCloseTimer = null;
        }
        cropper.hidden = false;
        requestAnimationFrame(() => {
            cropper.classList.add("is-open");
        });
        return;
    }

    cropper.classList.remove("is-open");
    if (profileCropperCloseTimer) clearTimeout(profileCropperCloseTimer);
    profileCropperCloseTimer = window.setTimeout(() => {
        cropper.hidden = true;
        const image = document.getElementById("account-photo-crop-image");
        if (image) {
            image.removeAttribute("src");
            image.style.width = "";
            image.style.height = "";
            image.style.transform = "";
        }
        profileCropperCloseTimer = null;
    }, PROFILE_CROPPER_TRANSITION_MS);
}

function isAllowedProfileImageFile(file) {
    const type = String(file?.type || "").toLowerCase();
    if (ALLOWED_PROFILE_IMAGE_MIME_TYPES.has(type)) return true;
    const name = String(file?.name || "").toLowerCase();
    return /\.(jpe?g|png|webp|gif)$/i.test(name);
}

async function readFileAsDataUrl(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Impossible de lire ce fichier."));
        reader.readAsDataURL(file);
    });
}

function setPendingProfilePreviewFromFile(file, cropMeta = null) {
    revokePendingProfileObjectUrl();
    const objectUrl = URL.createObjectURL(file);
    pendingProfilePhotoObjectUrl = appendAvatarCropMeta(objectUrl, cropMeta);
    updateAccountAvatarPreview();
}

function clampPendingCropOffsets() {
    if (!pendingProfilePhotoCropState) return;
    const maxX = Math.max(0, (pendingProfilePhotoCropState.renderWidth * pendingProfilePhotoCropState.zoom - PROFILE_AVATAR_CROP_BOX_SIZE) / 2);
    const maxY = Math.max(0, (pendingProfilePhotoCropState.renderHeight * pendingProfilePhotoCropState.zoom - PROFILE_AVATAR_CROP_BOX_SIZE) / 2);
    pendingProfilePhotoCropState.offsetX = Math.min(maxX, Math.max(-maxX, pendingProfilePhotoCropState.offsetX));
    pendingProfilePhotoCropState.offsetY = Math.min(maxY, Math.max(-maxY, pendingProfilePhotoCropState.offsetY));
}

function renderPendingCropPreview() {
    if (!pendingProfilePhotoCropState) return;
    const image = document.getElementById("account-photo-crop-image");
    if (!image) return;
    const zoom = Math.max(PROFILE_AVATAR_MIN_ZOOM, Math.min(PROFILE_AVATAR_MAX_ZOOM, pendingProfilePhotoCropState.zoom));
    pendingProfilePhotoCropState.zoom = zoom;
    clampPendingCropOffsets();
    image.style.transform = `translate(-50%, -50%) translate(${pendingProfilePhotoCropState.offsetX}px, ${pendingProfilePhotoCropState.offsetY}px) scale(${zoom})`;
}

function resetPendingCropTransform() {
    if (!pendingProfilePhotoCropState) return;
    pendingProfilePhotoCropState.offsetX = 0;
    pendingProfilePhotoCropState.offsetY = 0;
    pendingProfilePhotoCropState.zoom = 1;
    const zoomInput = document.getElementById("account-photo-crop-zoom");
    if (zoomInput) zoomInput.value = "1";
    renderPendingCropPreview();
}

function setupPendingCropDrag() {
    const stage = document.getElementById("account-photo-crop-stage");
    if (!stage || stage.dataset.bound === "1") return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startOffsetX = 0;
    let startOffsetY = 0;

    stage.addEventListener("pointerdown", event => {
        if (!pendingProfilePhotoCropState) return;
        isDragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startOffsetX = pendingProfilePhotoCropState.offsetX;
        startOffsetY = pendingProfilePhotoCropState.offsetY;
        stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener("pointermove", event => {
        if (!isDragging || !pendingProfilePhotoCropState) return;
        pendingProfilePhotoCropState.offsetX = startOffsetX + (event.clientX - startX);
        pendingProfilePhotoCropState.offsetY = startOffsetY + (event.clientY - startY);
        renderPendingCropPreview();
    });

    const endDrag = event => {
        if (!isDragging) return;
        isDragging = false;
        try {
            stage.releasePointerCapture(event.pointerId);
        } catch {}
    };

    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.dataset.bound = "1";
}

async function initializePendingCropFromFile(file) {
    const cropper = document.getElementById("account-photo-cropper");
    const image = document.getElementById("account-photo-crop-image");
    const zoomInput = document.getElementById("account-photo-crop-zoom");
    if (!cropper || !image || !zoomInput) return;

    const dataUrl = await readFileAsDataUrl(file);
    const naturalSize = await new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => reject(new Error("Image invalide ou corrompue."));
        probe.src = dataUrl;
    });

    const baseScale = Math.max(
        PROFILE_AVATAR_CROP_BOX_SIZE / naturalSize.width,
        PROFILE_AVATAR_CROP_BOX_SIZE / naturalSize.height
    );

    pendingProfilePhotoCropState = {
        dataUrl,
        sourceFile: file,
        sourceMimeType: String(file?.type || "").toLowerCase(),
        naturalWidth: naturalSize.width,
        naturalHeight: naturalSize.height,
        renderWidth: naturalSize.width * baseScale,
        renderHeight: naturalSize.height * baseScale,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
    };

    await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Impossible d'afficher l'image pour le recadrage."));
        image.src = dataUrl;
    });
    image.style.width = `${pendingProfilePhotoCropState.renderWidth}px`;
    image.style.height = `${pendingProfilePhotoCropState.renderHeight}px`;
    zoomInput.value = "1";
    renderPendingCropPreview();
    togglePhotoCropper(true);
}

function computeCropSelectionFromState(state) {
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

function getCropOutputMimeType(sourceMimeType = "") {
    if (sourceMimeType === "image/png") return "image/png";
    if (sourceMimeType === "image/jpeg" || sourceMimeType === "image/jpg") return "image/jpeg";
    if (sourceMimeType === "image/webp") return "image/webp";
    return "image/webp";
}

async function buildCroppedAvatarBlob() {
    if (!pendingProfilePhotoCropState) {
        throw new Error("Aucun recadrage en attente.");
    }

    const imageElement = document.getElementById("account-photo-crop-image");
    if (!imageElement) {
        throw new Error("Prévisualisation de recadrage indisponible.");
    }

    const selection = computeCropSelectionFromState(pendingProfilePhotoCropState);
    if (!selection) throw new Error("Recadrage impossible.");

    const canvas = document.createElement("canvas");
    canvas.width = PROFILE_AVATAR_OUTPUT_SIZE;
    canvas.height = PROFILE_AVATAR_OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Impossible de traiter cette image.");

    ctx.drawImage(
        imageElement,
        selection.sourceX,
        selection.sourceY,
        selection.sourceSize,
        selection.sourceSize,
        0,
        0,
        PROFILE_AVATAR_OUTPUT_SIZE,
        PROFILE_AVATAR_OUTPUT_SIZE
    );

    const targetMimeType = getCropOutputMimeType(pendingProfilePhotoCropState.sourceMimeType);
    const quality = targetMimeType === "image/jpeg" ? 0.9 : (targetMimeType === "image/webp" ? 0.9 : undefined);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, targetMimeType, quality));
    if (!blob) throw new Error("Recadrage impossible.");
    return blob;
}

async function handleApplyPendingCrop() {
    try {
        if (pendingProfilePhotoCropState?.sourceMimeType === "image/gif" && pendingProfilePhotoCropState.sourceFile) {
            const selection = computeCropSelectionFromState(pendingProfilePhotoCropState);
            if (!selection) throw new Error("Recadrage GIF impossible.");
            pendingProfilePhotoCropMeta = selection.cropMeta;
            pendingProfilePhotoFile = pendingProfilePhotoCropState.sourceFile;
            setPendingProfilePreviewFromFile(pendingProfilePhotoFile, pendingProfilePhotoCropMeta);
            togglePhotoCropper(false);
            showToast("GIF recadré en conservant l'animation. Clique sur « Enregistrer le profil ».", "success");
            const modal = document.getElementById("account-photo-modal");
            if (modal) modal.hidden = true;
            return;
        }

        const blob = await buildCroppedAvatarBlob();
        const extension = inferAvatarExtension({ type: blob.type || getCropOutputMimeType(pendingProfilePhotoCropState?.sourceMimeType) });
        const croppedFile = new File([blob], `avatar-${Date.now()}.${extension}`, { type: blob.type || `image/${extension}` });
        pendingProfilePhotoCropMeta = null;
        pendingProfilePhotoFile = croppedFile;
        setPendingProfilePreviewFromFile(croppedFile, null);
        togglePhotoCropper(false);
        showToast("Recadrage appliqué. Clique sur « Enregistrer le profil ».", "success");
        const modal = document.getElementById("account-photo-modal");
        if (modal) modal.hidden = true;
    } catch (err) {
        showToast(err?.message || "Recadrage impossible.", "error");
    }
}

async function handleAccountPhotoFileChange(event) {
    const fileInput = event.currentTarget;
    const file = fileInput?.files?.[0];
    if (!file) return;

    const clearBtn = document.getElementById("account-photo-clear-btn");
    if (fileInput) fileInput.disabled = true;

    try {
        if (!isAllowedProfileImageFile(file)) {
            throw new Error("Format non supporté. Utilise JPG, PNG, WEBP ou GIF.");
        }
        if (file.size > MAX_PROFILE_IMAGE_FILE_BYTES) {
            throw new Error("Image trop volumineuse (max 6 Mo).");
        }

        const photoInput = document.getElementById("account-photo-url");
        if (photoInput) photoInput.value = "";
        clearPendingProfilePhotoSelection();

        await initializePendingCropFromFile(file);
        showToast("Ajuste le recadrage puis applique.", "info");

        if (clearBtn) clearBtn.disabled = false;
        const defaultBtn = document.getElementById("account-photo-default-btn");
        if (defaultBtn) {
            const currentPhoto = String(document.getElementById("account-photo-url")?.value || "").trim();
            const defaultPhoto = getDefaultProviderPhotoUrl(currentUser);
            defaultBtn.disabled = !defaultPhoto || stripAvatarCropMeta(currentPhoto) === stripAvatarCropMeta(defaultPhoto);
        }
    } catch (err) {
        const message = err?.message || "Impossible d'importer cette image.";
        showToast(message, "error");
    } finally {
        if (fileInput) {
            fileInput.disabled = false;
            fileInput.value = "";
        }
    }
}

function renderCategoryManagerPanelIn(containerId, registry) {
    const panel = document.getElementById(containerId);
    if (!panel) return;

    if (!registry.list.length) {
        panel.innerHTML = `
            <p class="category-manager-empty">Aucune catégorie personnalisée pour le moment.</p>
        `;
        return;
    }

    panel.innerHTML = `
        <div class="category-manager-list">
            ${registry.list.map((entry, index) => `
                <div class="category-manager-item" data-category="${escapeHtml(entry.name)}" data-key="${escapeHtml(entry.key)}">
                    <div class="form-group">
                        <label for="cat-name-${index}">Nom de la catégorie</label>
                        <input type="text" id="cat-name-${index}" class="category-manager-name-input" value="${escapeHtml(entry.name)}" maxlength="50" autocomplete="off" spellcheck="false" aria-label="Nom de la catégorie ${escapeHtml(entry.name)}">
                    </div>
                    <div class="category-color-config">
                        <label for="cat-color-${index}">Personnalisation de la catégorie</label>
                        <div class="category-personalization-config">
                            <div class="category-color-controls">
                                <input type="color" id="cat-color-${index}" class="category-color-swatch" value="${entry.color}" aria-label="Choisir une couleur pour ${escapeHtml(entry.name)}">
                                <input type="text" id="cat-color-hex-${index}" class="category-color-hex" value="${entry.color}" maxlength="7" pattern="^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3})?$" aria-label="Code hexadécimal pour ${escapeHtml(entry.name)}">
                            </div>
                            <div class="category-pattern-config">
                                <label for="cat-pattern-${index}">Motif de fond</label>
                                <select id="cat-pattern-${index}" class="category-pattern-select" aria-label="Choisir un motif de fond pour ${escapeHtml(entry.name)}">
                                    ${buildCategoryPatternOptions(entry.pattern || "none")}
                                </select>
                            </div>
                            <div class="category-pattern-preview" id="cat-pattern-preview-${index}" aria-hidden="true"></div>
                        </div>
                    </div>
                </div>
            `).join("")}
        </div>
    `;

    panel.querySelectorAll(".category-manager-item").forEach(item => {
        const nameInput = item.querySelector(".category-manager-name-input");
        const colorInput = item.querySelector(".category-color-swatch");
        const hexInput = item.querySelector(".category-color-hex");
        const patternSelect = item.querySelector(".category-pattern-select");
        const patternPreview = item.querySelector(".category-pattern-preview");
        if (!nameInput || !colorInput || !hexInput || !patternSelect) return;
        item.dataset.color = normalizeHexColor(colorInput.value, "#CC0000");
        item.dataset.pattern = normalizeCategoryPatternKey(patternSelect.value, "none");

        const updatePatternPreview = () => {
            const patternKey = normalizeCategoryPatternKey(patternSelect.value, "none");
            const zoom = getSmallestPatternZoom(patternKey);
            applyPatternPreview(patternPreview, patternSelect.value, {
                color: colorInput.value,
                zoom
            });
        };
        updatePatternPreview();

        const syncAndPreview = source => {
            const color = normalizeHexColor(colorInput.value, "#CC0000");
            colorInput.value = color;
            if (source !== "hex" || document.activeElement !== hexInput) {
                hexInput.value = color;
            }
            updatePatternPreview();
        };

        const persist = async () => {
            const categoryName = item.dataset.category || "";
            const nextColor = normalizeHexColor(colorInput.value, "#CC0000");
            const nextPattern = normalizeCategoryPatternKey(patternSelect.value, "none");
            const nextPatternZoom = getSmallestPatternZoom(nextPattern);
            const shouldPersistColor = normalizeHexColor(colorInput.value, "#CC0000") !== normalizeHexColor(item.dataset.color || "", "#CC0000");
            const shouldPersistPattern = nextPattern !== normalizeCategoryPatternKey(item.dataset.pattern || "none", "none");
            if (!shouldPersistColor && !shouldPersistPattern) return;
            colorInput.disabled = true;
            hexInput.disabled = true;
            patternSelect.disabled = true;
            try {
                if (shouldPersistColor) {
                    await updateCategoryColorForName(categoryName, nextColor);
                    item.dataset.color = nextColor;
                }
                if (shouldPersistPattern) {
                    await updateCategoryPatternForName(categoryName, nextPattern, nextPatternZoom);
                    item.dataset.pattern = nextPattern;
                }
                showToast(`Catégorie ${categoryName} mise à jour.`, "success");
            } catch (err) {
                const details = getFriendlyErrorDetails(err, "la mise à jour de la catégorie");
                showToast(`${details.userMessage} Voir la console (F12).`, "error");
                logStyledError("Mise à jour catégorie", err, details, { categoryName, nextColor, nextPattern, nextPatternZoom });
            } finally {
                colorInput.disabled = false;
                hexInput.disabled = false;
                patternSelect.disabled = false;
            }
        };

        const handleRename = async () => {
            const currentName = item.dataset.category || "";
            const currentKey = normalizeCategoryName(currentName);
            const nextName = String(nameInput.value || "").trim().replace(/\s+/g, " ");
            const nextKey = normalizeCategoryName(nextName);

            nameInput.classList.remove("is-invalid");

            if (!nextName || nextKey === currentKey) {
                nameInput.value = currentName;
                return;
            }
            if (isDefaultCategoryName(nextName)) {
                nameInput.value = currentName;
                showToast(`« ${nextName} » est un nom réservé.`, "error");
                return;
            }
            if (dashboardCategoryRegistry.byKey[nextKey]) {
                nameInput.classList.add("is-invalid");
                showToast(`La catégorie « ${nextName} » existe déjà.`, "error");
                return;
            }

            nameInput.disabled = true;
            colorInput.disabled = true;
            hexInput.disabled = true;
            patternSelect.disabled = true;
            try {
                await renameCategoryForName(currentName, nextName);
                item.dataset.category = nextName;
                item.dataset.key = nextKey;
                nameInput.value = nextName;
                showToast(`Catégorie renommée en « ${nextName} ».`, "success");
            } catch (err) {
                const details = getFriendlyErrorDetails(err, "le renommage de la catégorie");
                showToast(`${details.userMessage} Voir la console (F12).`, "error");
                logStyledError("Renommage catégorie", err, details, { from: currentName, to: nextName });
                nameInput.value = currentName;
            } finally {
                nameInput.disabled = false;
                colorInput.disabled = false;
                hexInput.disabled = false;
                patternSelect.disabled = false;
            }
        };

        nameInput.addEventListener("input", () => nameInput.classList.remove("is-invalid"));
        nameInput.addEventListener("blur", handleRename);
        nameInput.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                nameInput.blur();
            }
        });

        colorInput.addEventListener("input", () => syncAndPreview("picker"));
        colorInput.addEventListener("change", async () => {
            syncAndPreview("picker");
            await persist();
        });
        hexInput.addEventListener("input", () => {
            const candidate = normalizeHexColor(hexInput.value, "");
            if (!candidate) return;
            colorInput.value = candidate;
            syncAndPreview("hex");
        });
        hexInput.addEventListener("blur", async () => {
            const normalized = normalizeHexColor(hexInput.value, "#CC0000");
            colorInput.value = normalized;
            syncAndPreview("hex");
            await persist();
        });
        patternSelect.addEventListener("change", async () => {
            updatePatternPreview();
            await persist();
        });
    });
}

function inferAvatarExtension(file) {
    const type = String(file?.type || "").toLowerCase();
    if (type === "image/gif") return "gif";
    if (type === "image/png") return "png";
    if (type === "image/jpeg") return "jpg";
    return "webp";
}

async function generatedAvatarDataUrlToFile(dataUrl, fileName = `avatar-generated-${Date.now()}.png`) {
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

function getStoragePathFromPublicUrl(url) {
    if (!url || typeof url !== "string") return null;
    const marker = "/o/";
    const cleanUrl = stripAvatarCropMeta(url);
    const markerIndex = cleanUrl.indexOf(marker);
    if (markerIndex === -1) return null;
    const encodedPath = cleanUrl.slice(markerIndex + marker.length).split("?")[0] || "";
    if (!encodedPath) return null;
    return decodeURIComponent(encodedPath);
}

async function deleteOldProfilePhotoIfManaged(previousUrl, uid) {
    const storagePath = getStoragePathFromPublicUrl(previousUrl);
    if (!storagePath) return;
    const expectedPrefix = `users/${uid}/profile/`;
    if (!storagePath.startsWith(expectedPrefix)) return;
    try {
        await deleteObject(storageRef(storage, storagePath));
    } catch {}
}

async function uploadProfilePhotoFile(file) {
    if (!currentUser || !file) return null;

    const extension = inferAvatarExtension(file);
    const filePath = `users/${currentUser.uid}/profile/avatar_${Date.now()}.${extension}`;
    const fileRef = storageRef(storage, filePath);
    await uploadBytes(fileRef, file, {
        contentType: file.type || `image/${extension}`,
        cacheControl: "public, max-age=31536000, immutable"
    });
    return await getDownloadURL(fileRef);
}

async function handleAccountProfileSubmit(event) {
    event.preventDefault();
    if (!currentUser) return;

    const submitButton = event.currentTarget?.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    try {
        const displayName = String(document.getElementById("account-display-name")?.value || "").trim();
        const photoInput = String(document.getElementById("account-photo-url")?.value || "").trim();
        const previousPhoto = currentUser.photoURL || "";
        let photoURL = null;

        if (pendingProfilePhotoCropState && !pendingProfilePhotoFile) {
            throw new Error("Applique le recadrage avant d'enregistrer.");
        }

        if (pendingProfilePhotoFile) {
            photoURL = await uploadProfilePhotoFile(pendingProfilePhotoFile);
            if (pendingProfilePhotoCropMeta) {
                photoURL = appendAvatarCropMeta(photoURL, pendingProfilePhotoCropMeta);
            }
            await deleteOldProfilePhotoIfManaged(previousPhoto, currentUser.uid);
        } else if (photoInput && isGeneratedInitialsAvatarUrl(photoInput)) {
            const generatedAvatarFile = await generatedAvatarDataUrlToFile(photoInput);
            photoURL = await uploadProfilePhotoFile(generatedAvatarFile);
            await deleteOldProfilePhotoIfManaged(previousPhoto, currentUser.uid);
        } else if (photoInput) {
            const parsed = new URL(photoInput);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("URL de photo invalide");
            }
            photoURL = parsed.toString();
        } else {
            photoURL = createGeneratedInitialsAvatarUrl({
                displayName: displayName || currentUser.displayName || "",
                email: String(currentUser.email || ""),
                uid: String(currentUser.uid || ""),
                seed: Date.now().toString(36)
            });
            await deleteOldProfilePhotoIfManaged(previousPhoto, currentUser.uid);
        }

        await updateProfile(currentUser, {
            displayName: displayName || null,
            photoURL
        });
        await currentUser.reload();
        currentUser = auth.currentUser;

        showToast("Profil mis à jour.", "success");
        resetPendingProfilePhotoState();
        await renderAccountView();
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la mise à jour du profil");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Mise à jour profil", err, details, {
            displayName: document.getElementById("account-display-name")?.value || "",
            hasPhotoUrl: Boolean(document.getElementById("account-photo-url")?.value),
            hasPendingUpload: Boolean(pendingProfilePhotoFile)
        });
        if (submitButton) submitButton.disabled = false;
    }
}

async function handleAccountProviderAction(providerId, action = "link") {
    if (!currentUser) return;
    if (currentUser.isAnonymous) {
        showToast("Connectez-vous avec un compte pour lier des fournisseurs.", "warning");
        return;
    }

    const providerMeta = getProviderFactoryById(providerId);
    const linkedProviders = getLinkedProviderIds(currentUser);
    const isLinked = linkedProviders.includes(providerId);
    if (action === "unlink") {
        if (!isLinked) {
            showToast(`${getProviderLabel(providerId)} n'est pas lié.`, "info");
            return;
        }
        if (linkedProviders.length <= 1) {
            showToast("Ajoutez d'abord une autre méthode de connexion avant de délier ce fournisseur.", "warning");
            return;
        }

        const button = document.querySelector(`.account-provider-action-btn[data-provider-id="${providerId}"]`);
        if (button) button.disabled = true;
        try {
            await unlink(currentUser, providerId);
            showToast(`${getProviderLabel(providerId)} a été délié de votre compte.`, "success");
            await renderAccountView();
        } catch (err) {
            const details = getAuthErrorDetails(err, "la déliaison du compte", getProviderLabel(providerId));
            showToast(details.userMessage, "error");
            if (button && document.body.contains(button)) button.disabled = false;
        }
        return;
    }

    if (!providerMeta || providerMeta.enabled === false) {
        showToast(`Liaison ${getProviderLabel(providerId)} indisponible pour le moment.`, "info");
        return;
    }
    if (isLinked) {
        showToast(`${getProviderLabel(providerId)} est déjà lié.`, "info");
        return;
    }

    const button = document.querySelector(`.account-provider-action-btn[data-provider-id="${providerId}"]`);
    if (button) button.disabled = true;

    try {
        await linkWithPopup(currentUser, providerMeta.factory());
        showToast(`${getProviderLabel(providerId)} a été lié à votre compte.`, "success");
        await renderAccountView();
    } catch (err) {
        const code = extractErrorCode(err);
        if (code === "popup-closed-by-user" || code === "cancelled-popup-request") {
            if (button && document.body.contains(button)) button.disabled = false;
            return;
        }
        logAuthError("la liaison de compte", err, providerId, { mode: "link-provider" });
        if (button && document.body.contains(button)) button.disabled = false;
    }
}

async function handleAccountPasswordSubmit(event) {
    event.preventDefault();
    if (!currentUser || currentUser.isAnonymous) return;

    const form = event.currentTarget;
    const submitButton = form?.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    const linkedPassword = hasPasswordProvider(currentUser);
    const email = String(currentUser.email || document.getElementById("account-password-email")?.value || "").trim();
    const currentPassword = String(document.getElementById("account-password-current")?.value || "");
    const nextPassword = String(document.getElementById("account-password-next")?.value || "");
    const confirmPassword = String(document.getElementById("account-password-confirm")?.value || "");

    if (!email) {
        showToast("Ajoutez une adresse e-mail pour définir un mot de passe.", "warning");
        if (submitButton) submitButton.disabled = false;
        return;
    }
    if (nextPassword.length < 6) {
        showToast("Le mot de passe doit contenir au moins 6 caractères.", "warning");
        if (submitButton) submitButton.disabled = false;
        return;
    }
    if (nextPassword !== confirmPassword) {
        showToast("La confirmation du mot de passe ne correspond pas.", "warning");
        if (submitButton) submitButton.disabled = false;
        return;
    }
    if (linkedPassword && !currentPassword) {
        showToast("Saisissez votre mot de passe actuel.", "warning");
        if (submitButton) submitButton.disabled = false;
        return;
    }

    try {
        if (linkedPassword) {
            const credential = EmailAuthProvider.credential(email, currentPassword);
            await reauthenticateWithCredential(currentUser, credential);
            await updatePassword(currentUser, nextPassword);
            showToast("Mot de passe mis à jour.", "success");
            form?.reset();
        } else {
            const existingMethods = await getSignInMethodsForEmailAddress(email);
            if (existingMethods.length) {
                const conflictMessage = buildEmailAuthConflictMessage(existingMethods, "signup")
                    || `Cette adresse est déjà liée à ${formatAuthMethods(existingMethods)}.`;
                showToast(conflictMessage, "warning");
                if (submitButton) submitButton.disabled = false;
                return;
            }

            const credential = EmailAuthProvider.credential(email, nextPassword);
            await linkWithCredential(currentUser, credential);
            showToast("Mot de passe ajouté à votre compte.", "success");
            await renderAccountView();
            return;
        }
    } catch (err) {
        const code = extractErrorCode(err);
        let toastMessage;

        if (code === "invalid-credential" && linkedPassword) {
            toastMessage = "Mot de passe actuel incorrect.";
        }

        if (code === "email-already-in-use" && email) {
            const methods = await getSignInMethodsForEmailAddress(email);
            toastMessage = buildEmailAuthConflictMessage(methods, "signup") || toastMessage;
        }

        logAuthError("la gestion du mot de passe", err, "email/password", {
            mode: linkedPassword ? "change-password" : "set-password",
            toastMessage
        });
    } finally {
        if (submitButton && document.body.contains(submitButton)) submitButton.disabled = false;
    }
}

async function handleAccountPasswordResetFromAccount() {
    const email = String(currentUser?.email || "").trim();
    if (!email) {
        showToast("Aucune adresse e-mail liée à ce compte.", "warning");
        return;
    }

    try {
        await sendPasswordResetEmail(auth, email);
        showToast("E-mail de réinitialisation envoyé.", "success");
    } catch (err) {
        logAuthError("l'envoi de l'e-mail de réinitialisation", err, "email/password", { mode: "account-reset-password" });
    }
}

async function handlePurgeUserData() {
    if (!currentUser) return;

    const confirmed = await showAppModal({
        title: "Purger les données",
        message: "Tous vos bingos seront supprimés définitivement.",
        confirmText: "Purger",
        cancelText: "Annuler",
        confirmVariant: "danger"
    });
    if (!confirmed) return;

    const purgeButton = document.getElementById("purge-data-btn");
    const deleteButton = document.getElementById("delete-account-btn");
    if (purgeButton) purgeButton.disabled = true;
    if (deleteButton) deleteButton.disabled = true;

    try {
        await purgeUserBingos();
        showToast("Vos données Bingo ont été purgées.", "success");
        renderCategoryManagerPanelIn("account-category-manager", dashboardCategoryRegistry);
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la purge des données");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Purge données", err, details, { uid: currentUser.uid });
    } finally {
        if (purgeButton) purgeButton.disabled = false;
        if (deleteButton) deleteButton.disabled = false;
    }
}

async function handleDeleteAccount() {
    if (!currentUser) return;

    const confirmed = await showAppModal({
        title: "Supprimer le compte",
        message: "Votre compte lié à Bingo et toutes vos données Bingo seront supprimés définitivement. Il ne s'agit pas d'un bannissement : vous pourrez recréer un compte en vous reconnectant.",
        confirmText: "Supprimer",
        cancelText: "Annuler",
        confirmVariant: "danger"
    });
    if (!confirmed) return;

    const purgeButton = document.getElementById("purge-data-btn");
    const deleteButton = document.getElementById("delete-account-btn");
    if (purgeButton) purgeButton.disabled = true;
    if (deleteButton) deleteButton.disabled = true;

    try {
        await purgeUserBingos();
        try {
            await deleteUser(currentUser);
        } catch (err) {
            if (err?.code !== "auth/requires-recent-login") throw err;
            const provider = getReauthProvider();
            if (!provider) {
                showToast("Pour des raisons de sécurité, reconnectez-vous puis relancez la suppression.", "warning");
                clearPersistedAppState();
                await signOut(auth);
                return;
            }
            await reauthenticateWithPopup(currentUser, provider);
            await deleteUser(currentUser);
        }
        clearPersistedAppState();
        showToast("Compte supprimé avec succès.", "success");
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la suppression du compte");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Suppression compte", err, details, { uid: currentUser.uid });
        if (purgeButton) purgeButton.disabled = false;
        if (deleteButton) deleteButton.disabled = false;
    }
}

function getReauthProvider() {
    const providerId = currentUser?.providerData?.[0]?.providerId;
    switch (providerId) {
        case "google.com": {
            const provider = new GoogleAuthProvider();
            provider.setCustomParameters({ prompt: "select_account" });
            return provider;
        }
        case "github.com": return new GithubAuthProvider();
        case "twitter.com": return new TwitterAuthProvider();
        case "microsoft.com": return new OAuthProvider("microsoft.com");
        default: return null;
    }
}

async function changeFilter(cat) {
    const searchQuery = document.getElementById("dashboard-search")?.value || "";
    setCurrentViewState({ name: "dashboard", filterCategory: cat || null, searchQuery, bingoId: null, editId: null });
    const filters = document.getElementById("category-filters");
    filters?.querySelectorAll(".chip").forEach(c => {
        c.classList.toggle("is-active", (c.dataset.cat || "") === (cat || ""));
    });
    const select = document.getElementById("category-filter-select");
    if (select && select.value !== (cat || "")) {
        select.value = cat || "";
    }
    const list = document.getElementById("bingo-list");
    if (list) {
        if (!prefersReducedMotion()) {
            list.classList.remove("ui-fade-enter", "ui-fade-enter-active");
            list.classList.add("ui-fade-leave");
            await wait(HEADER_TRANSITION_MS);
        }
        list.innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div class="loading-spinner"></div></div>`;
        animateElementIn(list);
    }
    await wait(120);
    applyDashboardFilters(cat, searchQuery);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeHexColor(value, fallback = "#CC0000") {
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

function normalizeCssVarContent(value) {
    return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function getAllowedPatternZooms(patternKey = "none") {
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

function normalizePatternZoom(value, fallback = 1, patternKey = null) {
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

function getSmallestPatternZoom(patternKey = "none") {
    const allowed = getAllowedPatternZooms(patternKey);
    return allowed[0] || 1;
}

function scalePatternSize(sizeValue, zoom = 1) {
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

function humanizePatternKey(key) {
    return String(key || "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, char => char.toUpperCase());
}

function getCategoryPatternPresets() {
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

function normalizeCategoryPatternKey(value, fallback = "none") {
    const key = String(value || "").trim();
    if (!key) return fallback;
    const presets = getCategoryPatternPresets();
    return presets.some(preset => preset.key === key) ? key : fallback;
}

function getCategoryPatternPresetByKey(patternKey) {
    const presets = getCategoryPatternPresets();
    return presets.find(preset => preset.key === patternKey) || presets[0];
}

function buildCategoryPatternOptions(selectedPattern = "none") {
    const normalized = normalizeCategoryPatternKey(selectedPattern, "none");
    return getCategoryPatternPresets().map(preset =>
        `<option value="${escapeHtml(preset.key)}" ${preset.key === normalized ? "selected" : ""}>${escapeHtml(preset.label)}</option>`
    ).join("");
}

function applyPatternPreview(previewElement, patternKey = "none", options = {}) {
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

function hexToRgb(hexColor) {
    const color = normalizeHexColor(hexColor);
    const hex = color.slice(1);
    return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16)
    };
}

function hexToRgba(hexColor, alpha = 1) {
    const { r, g, b } = hexToRgb(hexColor);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenHexColor(hexColor, percent = 18) {
    const { r, g, b } = hexToRgb(hexColor);
    const ratio = Math.max(0, Math.min(percent, 100)) / 100;
    const shade = channel => Math.max(0, Math.round(channel * (1 - ratio)));
    const toHex = value => value.toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(shade(r))}${toHex(shade(g))}${toHex(shade(b))}`;
}

function getReadableTextColor(hexColor) {
    const { r, g, b } = hexToRgb(hexColor);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.62 ? "#111111" : "#FFFFFF";
}

function buildCategoryInlineStyle(color, pattern = "none", zoom = 1) {
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

function buildBingoAccentStyle(color) {
    const base = normalizeHexColor(color);
    return [
        `--bingo-accent:${base}`,
        `--bingo-accent-dark:${darkenHexColor(base, 22)}`,
        `--bingo-accent-contrast:${getReadableTextColor(base)}`
    ].join(";");
}

function normalizeCategoryName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isReservedCategoryName(value) {
    const normalized = normalizeCategoryName(value);
    return normalized === "ajouter une catégorie...";
}

function isDefaultCategoryName(value) {
    const normalized = normalizeCategoryName(value);
    const defaultNames = new Set([
        normalizeCategoryName("Sans catégorie"),
        normalizeCategoryName("Toutes les catégories"),
        normalizeCategoryName("Toutes les categories"),
        normalizeCategoryName("Tous")
    ]);
    return defaultNames.has(normalized) || isReservedCategoryName(value);
}

function buildCategoryRegistry(bingos) {
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

function buildCategoryTagMarkup(category, color, pattern = "none", extraClass = "") {
    const className = ["tag-category", extraClass].filter(Boolean).join(" ");
    return `<span class="${className}" style="${buildCategoryInlineStyle(color, pattern)}">${escapeHtml(category || "Sans catégorie")}</span>`;
}

function buildHeaderTagMarkup(text) {
    return `<span class="header-tag header-tag-live">${escapeHtml(text || "Bingo")}</span>`;
}

function startBodyThemeTransition() {
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

function applyBodyAccentTheme(color, pattern = "none", zoom = 1) {
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

function resetBodyAccentTheme() {
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

function debugPlayOverflow(source) {
    const root = document.documentElement;
    const view = document.querySelector(".view-play");
    const playBody = document.querySelector(".view-play .play-body");
    const board = document.querySelector(".view-play .bingo-board-wrap");
    const grid = document.querySelector(".view-play .bingo-grid-play");
    if (!root || !view || !playBody || !board || !grid) return;

    const overflowY = Math.max(0, Math.round(root.scrollHeight - window.innerHeight));
    const metrics = {
        source,
        viewportHeight: window.innerHeight,
        documentScrollHeight: root.scrollHeight,
        overflowY,
        viewHeight: Math.round(view.getBoundingClientRect().height),
        playBodyHeight: Math.round(playBody.getBoundingClientRect().height),
        boardHeight: Math.round(board.getBoundingClientRect().height),
        gridHeight: Math.round(grid.getBoundingClientRect().height)
    };

    const culprit = overflowY > 0
        ? ([grid, board, playBody].find(el => el.scrollHeight - el.clientHeight > 1) || grid)
        : null;

    console.info("[bingo-overflow-debug]", {
        ...metrics,
        culprit: culprit?.className || null
    });
}

function renderBingoCards(bingos, { filterCategory = null, searchQuery = "", regexError = null } = {}) {
    const el = document.getElementById("bingo-list");
    if (!el) return;
    if (!bingos.length) {
        const query = (searchQuery || "").trim();
        if (query && !regexError) {
            el.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="search-x" aria-hidden="true"></i>
                    <p>Aucun resultat pour "${escapeHtml(query)}".</p>
                    <p>La recherche couvre les titres, les categories et le contenu des cases.</p>
                    <button type="button" id="empty-clear-search" class="btn btn--neutral btn--sm">Effacer la recherche</button>
                </div>
            `;
            document.getElementById("empty-clear-search")?.addEventListener("click", () => {
                const input = document.getElementById("dashboard-search");
                if (!input) return;
                input.value = "";
                handleDashboardSearchInput();
                input.focus();
            });
        } else if (filterCategory) {
            el.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="layout-grid" aria-hidden="true"></i>
                    <p>Aucun bingo dans la categorie "${escapeHtml(filterCategory)}".</p>
                    <p>Essayez une autre categorie ou creez un nouveau bingo.</p>
                </div>
            `;
        } else {
            el.innerHTML = `
                <div class="empty-state">
                    <i data-lucide="layout-grid" aria-hidden="true"></i>
                    <p>Aucun bingo pour le moment.</p>
                    <p>Cliquez sur "Nouveau bingo" pour commencer !</p>
                </div>
            `;
        }
        animateElementIn(el);
        initIcons();
        return;
    }
    el.innerHTML = bingos.map(b => `
        <article class="bingo-card" data-id="${b.id}" tabindex="0" role="button" aria-label="Ouvrir le bingo ${b.title}">
            <div class="bingo-card-meta">
                ${buildCategoryTagMarkup(b.category, b.categoryColor, b.categoryPattern)}
                <span class="tag-size">${b.size}x${b.size}</span>
            </div>
            <h3 class="bingo-card-title">${b.title}</h3>
            <div aria-hidden="true">${buildMiniPreview(b)}</div>
            <div class="bingo-card-actions">
                <button type="button" class="btn btn--neutral btn--sm btn--icon js-edit" data-id="${b.id}" aria-label="Modifier ${b.title}">
                    <i data-lucide="pencil" aria-hidden="true"></i>
                </button>
                <button type="button" class="btn btn--danger btn--sm btn--icon js-delete" data-id="${b.id}" aria-label="Supprimer ${b.title}">
                    <i data-lucide="trash-2" aria-hidden="true"></i>
                </button>
            </div>
        </article>
    `).join("");
    el.querySelectorAll(".js-edit").forEach(btn => btn.addEventListener("click", e => {
        e.stopPropagation();
        void navigateWithHeader(() => renderCreateView(btn.dataset.id));
    }));
    el.querySelectorAll(".js-delete").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); handleDeleteBingo(btn.dataset.id); }));
    el.querySelectorAll(".bingo-card").forEach(card => {
        card.addEventListener("click", () => {
            void navigateWithHeader(() => renderPlayView(card.dataset.id));
        });
        card.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void navigateWithHeader(() => renderPlayView(card.dataset.id));
            }
        });
    });
    animateElementIn(el);
    initIcons();
}

function buildMiniPreview(bingo) {
    const size = Math.max(3, Math.min(Number(bingo.size) || 3, 5));
    const marked = bingo.markedCells || [];
    const cells = Array.from({ length: size * size }, (_, i) =>
        `<div class="mini-cell${marked[i] ? " marked" : ""}"></div>`
    ).join("");
    return `<div class="mini-grid-container mini-grid-${size}" style="${buildBingoAccentStyle(bingo.categoryColor)}">${cells}</div>`;
}

async function handleDeleteBingo(id) {
    const confirmed = await showAppModal({
        title: "Supprimer ce bingo",
        message: "Cette action est définitive. Voulez-vous continuer ?",
        confirmText: "Supprimer",
        cancelText: "Annuler",
        confirmVariant: "danger"
    });
    if (!confirmed) return;
    try {
        await deleteDoc(bingoDocRef(id));
        showToast("Bingo supprimé.", "success");
        await navigateWithHeader(() => renderDashboard());
    } catch {
        showToast("Erreur lors de la suppression.", "error");
    }
}


async function renderCreateView(editId = null) {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "create", editId: editId || null, bingoId: null, filterCategory: null });
    await replaceAppMarkup(`
        <div class="view view-create">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        ${buildHeaderTagMarkup(editId ? "Modifier" : "Créer")}
                    </div>
                </div>
            </header>
            <main class="create-body">
                <div class="loading-state"><div class="loading-spinner"></div></div>
            </main>
        </div>
    `);
    document.getElementById("back-btn")?.addEventListener("click", () => {
        void navigateWithHeader(() => renderDashboard());
    });
    initIcons();

    let existing = null;
    if (editId) {
        try {
            const snap = await getDoc(bingoDocRef(editId));
            if (snap.exists()) existing = { id: snap.id, ...snap.data() };
        } catch {
            showToast("Erreur lors du chargement.", "error");
            await renderDashboard();
            return;
        }
    }

    const draft = readCreateDraft(editId);
    const allBingos = await fetchBingos();
    const categoryRegistry = buildCategoryRegistry(allBingos);
    const categories = categoryRegistry.list.map(entry => entry.name);
    const selectedCategory = draft?.category ?? existing?.category ?? "";
    const normalizedSelectedCategory = normalizeCategoryName(selectedCategory);
    const selectedCategoryEntry = categoryRegistry.byKey[normalizedSelectedCategory] || null;
    const effectiveSelectedCategory = selectedCategoryEntry?.name || selectedCategory;
    const hasCustomCategory = !!effectiveSelectedCategory && !selectedCategoryEntry;
    const selectedCategoryValue = hasCustomCategory ? "__new__" : (selectedCategoryEntry?.name || "");
    const selectedCategoryColor = normalizeHexColor(
        selectedCategoryEntry?.color ?? draft?.categoryColor ?? existing?.categoryColor ?? "#CC0000"
    );
    const selectedCategoryPattern = normalizeCategoryPatternKey(
        selectedCategoryEntry?.pattern ?? draft?.categoryPattern ?? existing?.categoryPattern ?? "none",
        "none"
    );
    const size = draft?.size || existing?.size || 3;
    const main = document.querySelector(".view-create .create-body");
    if (!main) return;

    main.innerHTML = `
        <form id="create-form" class="create-form" novalidate>
            <h2 class="form-section-title">${editId ? "Modifier le bingo" : "Nouveau bingo"}</h2>
            <p class="form-required-note">Les champs marqués <span class="required-mark" aria-hidden="true">*</span> sont obligatoires.</p>
            <div class="form-row form-row-2">
                <div class="form-group">
                    <label for="f-title">Titre<span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="f-title" name="f-title"
                                 placeholder="Ex: Nintendo Direct Juin 2026"
                                 value="${draft?.title ?? existing?.title ?? ""}" required maxlength="100"
                                 aria-required="true" aria-describedby="hint-title">
                    <span id="hint-title" class="form-hint">100 caractères max.</span>
                </div>
                <div class="form-group">
                    <label for="f-category-select">Catégorie</label>
                    <select id="f-category-select" name="f-category-select" aria-describedby="hint-cat">
                        <option value="">Sans catégorie</option>
                        ${categories.map(c => `<option value="${escapeHtml(c)}" ${selectedCategoryValue === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
                        <option value="__new__" ${selectedCategoryValue === "__new__" ? "selected" : ""}>Ajouter une catégorie...</option>
                    </select>
                    <input type="text" id="f-category-new" name="f-category-new"
                                 class="${selectedCategoryValue === "__new__" ? "" : "hidden"}"
                                 placeholder="Ex: Nintendo, Gaming, Cinéma"
                                 value="${hasCustomCategory ? effectiveSelectedCategory : ""}" maxlength="50"
                                 aria-describedby="hint-cat">
                    <div class="category-color-config ${selectedCategoryValue === "__new__" ? "" : "hidden"}" id="category-color-config">
                        <label for="f-category-color">Personnalisation de la catégorie</label>
                        <div class="category-personalization-config">
                            <div class="category-color-controls">
                                <input type="color" id="f-category-color" name="f-category-color" value="${selectedCategoryColor}" aria-label="Choisir une couleur de catégorie">
                                <input type="text" id="f-category-color-hex" name="f-category-color-hex" value="${selectedCategoryColor}" maxlength="7" pattern="^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3})?$" aria-label="Valeur hexadécimale de la couleur de catégorie">
                            </div>
                            <div class="category-pattern-config" id="category-pattern-config">
                                <label for="f-category-pattern">Motif de fond</label>
                                <select id="f-category-pattern" name="f-category-pattern" aria-label="Choisir un motif de fond pour la catégorie">
                                    ${buildCategoryPatternOptions(selectedCategoryPattern)}
                                </select>
                            </div>
                            <div class="category-pattern-preview" id="f-category-pattern-preview" aria-hidden="true"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="form-group">
                <label for="f-size">Taille de la grille <span class="required-mark" aria-hidden="true">*</span></label>
                <select id="f-size" name="f-size" aria-describedby="hint-size">
                    <option value="3" ${size === 3 ? "selected" : ""}>3x3 (9 cases)</option>
                    <option value="4" ${size === 4 ? "selected" : ""}>4x4 (16 cases)</option>
                    <option value="5" ${size === 5 ? "selected" : ""}>5x5 (25 cases)</option>
                </select>
            </div>
            <div class="form-group">
                <span class="cells-label">Contenu des cases <span class="required-mark" aria-hidden="true">*</span></span>
                <span class="form-hint">Toutes les cases sont obligatoires.</span>
                <div id="cells-editor" class="cells-grid-editor cells-editor-${size}">
                    ${buildCellInputs(size, draft?.cells || existing?.cells)}
                </div>
            </div>
            <div class="form-actions">
                <button type="button" id="cancel-btn" class="btn btn--neutral">Annuler</button>
                <button type="submit" class="btn btn--primary">
                    ${editId ? "Enregistrer les modifications" : "Créer le bingo"}
                </button>
            </div>
        </form>
    `;
    animateElementIn(main.querySelector(".create-form") || main);

    document.getElementById("cancel-btn")?.addEventListener("click", () => {
        clearCreateDraft(editId);
        void navigateWithHeader(() => renderDashboard());
    });
    document.getElementById("f-size")?.addEventListener("change", e => {
        const newSize = parseInt(e.target.value);
        const editor = document.getElementById("cells-editor");
        if (!editor) return;
        const prevVals = [...editor.querySelectorAll("textarea")].map(t => t.value);
        editor.className = `cells-grid-editor cells-editor-${newSize}`;
        editor.innerHTML = buildCellInputs(newSize, prevVals);
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-select")?.addEventListener("change", e => {
        const customInput = document.getElementById("f-category-new");
        if (!customInput) return;
        const isCustom = e.target.value === "__new__";
        customInput.classList.toggle("hidden", !isCustom);
        if (isCustom) customInput.focus();
        if (!isCustom) {
            const detectedEntry = categoryRegistry.byKey[normalizeCategoryName(e.target.value || "")];
            const detectedColor = detectedEntry?.color;
            if (detectedColor) {
                const colorInput = document.getElementById("f-category-color");
                if (colorInput) colorInput.value = normalizeHexColor(detectedColor);
            }
            const patternSelect = document.getElementById("f-category-pattern");
            if (patternSelect) {
                patternSelect.value = normalizeCategoryPatternKey(detectedEntry?.pattern, "none");
            }
        }
        updateCategoryPreview();
        saveCreateDraft(editId);
    });

    function updateCategoryPreview(source = "picker") {
        const liveTag = document.querySelector(".category-live-tag");
        const select = document.getElementById("f-category-select");
        const customInput = document.getElementById("f-category-new");
        const colorInput = document.getElementById("f-category-color");
        const colorHexInput = document.getElementById("f-category-color-hex");
        const patternSelect = document.getElementById("f-category-pattern");
        const patternPreview = document.getElementById("f-category-pattern-preview");
        if (!colorInput || !colorHexInput || !patternSelect || !select || !customInput) return;

        const isCustom = select.value === "__new__";
        const categoryRaw = isCustom ? customInput.value : select.value;
        const isNoCategory = !String(categoryRaw || "").trim();
        const categoryKey = normalizeCategoryName(categoryRaw);
        const matchedEntry = categoryRegistry.byKey[categoryKey] || null;
        const shouldLockColor = !!matchedEntry || !isCustom;
        const categoryColorConfig = document.getElementById("category-color-config");

        const normalizedColor = normalizeHexColor(colorInput.value, "#CC0000");
        const resolvedColor = shouldLockColor
            ? normalizeHexColor(matchedEntry?.color || "#CC0000")
            : normalizedColor;
        const resolvedPattern = shouldLockColor
            ? normalizeCategoryPatternKey(matchedEntry?.pattern, "none")
            : normalizeCategoryPatternKey(patternSelect.value, "none");

        colorInput.value = resolvedColor;
        if (source !== "hex" || document.activeElement !== colorHexInput || shouldLockColor) {
            colorHexInput.value = resolvedColor;
        }
        colorInput.disabled = shouldLockColor;
        colorHexInput.disabled = shouldLockColor;
        patternSelect.disabled = shouldLockColor;
        patternSelect.value = resolvedPattern;
        const zoom = getSmallestPatternZoom(resolvedPattern);
        applyPatternPreview(patternPreview, resolvedPattern, {
            color: resolvedColor,
            zoom
        });
        if (categoryColorConfig) {
            categoryColorConfig.classList.toggle("hidden", shouldLockColor);
        }

        // Keep the global default background when "Sans catégorie" is selected.
        if (isNoCategory) {
            resetBodyAccentTheme();
        } else {
            applyBodyAccentTheme(resolvedColor, resolvedPattern, zoom);
        }

        if (liveTag) {
            liveTag.textContent = getCreateCategoryValue().trim() || "Sans catégorie";
            if (isNoCategory) {
                liveTag.style.cssText = "";
            } else {
                liveTag.style.cssText = buildCategoryInlineStyle(resolvedColor, resolvedPattern, zoom);
            }
        }
    }

    document.getElementById("f-category-new")?.addEventListener("input", () => {
        updateCategoryPreview();
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color")?.addEventListener("input", () => {
        updateCategoryPreview("picker");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color")?.addEventListener("change", () => {
        updateCategoryPreview("picker");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color-hex")?.addEventListener("input", e => {
        const candidate = normalizeHexColor(e.target.value, "");
        if (!candidate) return;
        const colorInput = document.getElementById("f-category-color");
        if (colorInput) colorInput.value = candidate;
        updateCategoryPreview("hex");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color-hex")?.addEventListener("blur", e => {
        const normalized = normalizeHexColor(e.target.value, "#CC0000");
        e.target.value = normalized;
        const colorInput = document.getElementById("f-category-color");
        if (colorInput) colorInput.value = normalized;
        updateCategoryPreview("hex");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-pattern")?.addEventListener("change", () => {
        updateCategoryPreview("pattern");
        saveCreateDraft(editId);
    });

    updateCategoryPreview();
    document.getElementById("create-form")?.addEventListener("input", () => saveCreateDraft(editId));
    document.getElementById("create-form")?.addEventListener("change", () => saveCreateDraft(editId));
    document.getElementById("create-form")?.addEventListener("submit", e => handleSaveBingo(e, editId));
    initIcons();
}

function buildCellInputs(size, values) {
    return Array.from({ length: size * size }, (_, i) => `
        <div class="cell-editor-wrap">
            <label for="cell-${i}">Case ${i + 1}</label>
            <textarea id="cell-${i}" name="cell-${i}" rows="2" maxlength="80"
                                placeholder="Saisir le contenu" aria-label="Contenu obligatoire de la case ${i + 1} du bingo, 80 caractères maximum" required aria-required="true">${values?.[i] || ""}</textarea>
        </div>
    `).join("");
}

async function handleSaveBingo(e, editId) {
    e.preventDefault();
    const title = document.getElementById("f-title")?.value.trim();
    const rawCategory = getCreateCategoryValue().trim();
    let category = rawCategory || "Sans catégorie";
    let categoryColor = getCreateCategoryColorValue();
    let categoryPattern = getCreateCategoryPatternValue();
    let categoryPatternZoom = getSmallestPatternZoom(categoryPattern);
    if (!rawCategory) categoryPattern = "none";
    if (!rawCategory) categoryPatternZoom = getSmallestPatternZoom("none");
    const size = parseInt(document.getElementById("f-size")?.value);

    if (!title) {
        showToast("Le titre est obligatoire.", "warning");
        document.getElementById("f-title")?.focus();
        return;
    }

    if (![3, 4, 5].includes(size)) {
        showToast("La taille de la grille est obligatoire.", "warning");
        document.getElementById("f-size")?.focus();
        return;
    }

    const cells = Array.from({ length: size * size }, (_, i) =>
        document.getElementById(`cell-${i}`)?.value.trim() || ""
    );

    const firstEmptyCellIndex = cells.findIndex(cell => !cell);
    if (firstEmptyCellIndex !== -1) {
        showToast(`La case ${firstEmptyCellIndex + 1} est obligatoire.`, "warning");
        document.getElementById(`cell-${firstEmptyCellIndex}`)?.focus();
        return;
    }

    const submit = document.querySelector("#create-form [type='submit']");
    if (submit) submit.disabled = true;

    try {
        const all = await fetchBingos();
        const categoryRegistry = buildCategoryRegistry(all);
        const rawCategoryKey = normalizeCategoryName(rawCategory);
        const matchedCategory = categoryRegistry.byKey[rawCategoryKey] || null;

        if (rawCategory && isDefaultCategoryName(rawCategory)) {
            showToast("Ce nom de catégorie est réservé par l'interface. Choisissez un autre nom.", "warning");
            document.getElementById("f-category-new")?.focus();
            if (submit) submit.disabled = false;
            return;
        }

        if (matchedCategory) {
            category = matchedCategory.name;
            categoryColor = matchedCategory.color;
            categoryPattern = normalizeCategoryPatternKey(matchedCategory.pattern, "none");
            categoryPatternZoom = getSmallestPatternZoom(categoryPattern);
        }

        const normalize = str => (str || "").trim().toLowerCase();
        const isDuplicate = all.some(b =>
            b.id !== editId &&
            normalize(b.title) === normalize(title) &&
            normalize(b.category) === normalize(category)
        );
        if (isDuplicate) {
            showToast("Un bingo avec ce titre existe déjà dans cette catégorie.", "warning");
            document.getElementById("f-title")?.focus();
            if (submit) submit.disabled = false;
            return;
        }

        if (editId) {
            await updateDoc(bingoDocRef(editId), { title, category, categoryColor, categoryPattern, categoryPatternZoom, size, cells, updatedAt: serverTimestamp() });
            showToast("Bingo modifié avec succès.", "success");
        } else {
            if (all.length >= MAX_BINGOS) {
                showToast(`Limite de ${MAX_BINGOS} bingos atteinte.`, "warning");
                if (submit) submit.disabled = false;
                return;
            }
            await addDoc(bingoCollRef(), {
                title,
                category,
                categoryColor,
                categoryPattern,
                categoryPatternZoom,
                size,
                cells,
                markedCells: new Array(size * size).fill(false),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            showToast("Bingo créé avec succès !", "success");
        }
        clearCreateDraft(editId);
        await navigateWithHeader(() => renderDashboard());
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la sauvegarde du bingo");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Sauvegarde bingo", err, details, {
            editId: editId || null,
            title,
            category,
            size
        });
        if (submit) submit.disabled = false;
    }
}


async function renderPlayView(bingoId) {
    setCurrentViewState({ name: "play", bingoId, editId: null, filterCategory: null });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    activeGameId = bingoId;
    hasShownWinModal = false;
    hasShownFinalWinModal = false;

    let bingo;
    try {
        const snap = await getDoc(bingoDocRef(bingoId));
        if (!snap.exists()) {
            showToast("Bingo introuvable.", "error");
            await renderDashboard();
            return;
        }
        bingo = { id: snap.id, ...snap.data() };
    } catch {
        showToast("Erreur lors du chargement du bingo.", "error");
        await renderDashboard();
        return;
    }

    const isNoCategoryBingo = normalizeCategoryName(bingo.category) === normalizeCategoryName("Sans catégorie");
    if (isNoCategoryBingo) {
        resetBodyAccentTheme();
    } else {
        applyBodyAccentTheme(
            bingo.categoryColor,
            bingo.categoryPattern,
            getSmallestPatternZoom(bingo.categoryPattern)
        );
    }
    liveMarkedCells = [...(bingo.markedCells || new Array(bingo.size * bingo.size).fill(false))];
    await renderPlayBoard(bingo);
}

async function renderPlayBoard(bingo) {
    const size = bingo.size;

    await replaceAppMarkup(`
        <div class="view view-play" style="${buildBingoAccentStyle(bingo.categoryColor)}">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-play-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour au tableau de bord">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text" title="${bingo.title}">${bingo.title}</span>
                        ${buildHeaderTagMarkup(bingo.category || "Bingo")}
                    </div>
                </div>
                <div class="header-right">
                    <button type="button" id="reset-btn" class="btn btn--ghost-light btn--sm btn--icon" aria-label="Réinitialiser les cases cochées">
                        <i data-lucide="rotate-ccw" aria-hidden="true"></i>
                    </button>
                </div>
            </header>
            <main class="play-body">
                <div class="bingo-board-wrap">
                    <div class="bingo-grid-play grid-${size}" role="grid" aria-label="Grille de bingo ${size}x${size}">
                        ${bingo.cells.map((cell, i) => `
                            <button type="button"
                                            class="bingo-cell${liveMarkedCells[i] ? " marked" : ""}"
                                            data-index="${i}"
                                            aria-pressed="${liveMarkedCells[i]}"
                                            aria-label="${cell || "Case vide"}, ${liveMarkedCells[i] ? "cochée" : "non cochée"}">
                                <span>${cell}</span>
                            </button>
                        `).join("")}
                    </div>
                </div>
            </main>
        </div>
    `);

    document.getElementById("back-play-btn")?.addEventListener("click", () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveMarkedCells(activeGameId, [...liveMarkedCells]);
        }
        void navigateWithHeader(() => renderDashboard());
    });

    document.getElementById("reset-btn")?.addEventListener("click", async () => {
        const confirmed = await showAppModal({
            title: "Réinitialiser la grille",
            message: "Toutes les cases cochées vont être décochées.",
            confirmText: "Réinitialiser",
            cancelText: "Annuler"
        });
        if (!confirmed) return;
        liveMarkedCells = new Array(bingo.size * bingo.size).fill(false);
        hasShownWinModal = false;
        hasShownFinalWinModal = false;
        await renderPlayBoard(bingo);
        scheduleSave(activeGameId, [...liveMarkedCells]);
    });

    document.querySelectorAll(".bingo-cell").forEach(cell => {
        cell.addEventListener("click", () => {
            const i = parseInt(cell.dataset.index);
            liveMarkedCells[i] = !liveMarkedCells[i];
            cell.classList.toggle("marked", liveMarkedCells[i]);
            cell.setAttribute("aria-pressed", liveMarkedCells[i]);
            cell.setAttribute("aria-label", `${bingo.cells[i] || "Case vide"}, ${liveMarkedCells[i] ? "cochée" : "non cochée"}`);

            const isWinner = checkBingoWin(liveMarkedCells, bingo.size);
            const isFullGridWinner = checkFullGridWin(liveMarkedCells);

            if (isFullGridWinner && !hasShownFinalWinModal) {
                hasShownFinalWinModal = true;
                hasShownWinModal = true;
                showAppModal({
                    title: "Bingo final !",
                    message: "Incroyable, toute la grille est complete.",
                    confirmText: "Continuer",
                    hideCancel: true
                });
            } else if (isWinner && !hasShownWinModal) {
                hasShownWinModal = true;
                showAppModal({
                    title: "Bingo !",
                    message: "Félicitations, vous avez complété une ligne gagnante.",
                    confirmText: "Continuer",
                    hideCancel: true
                });
            }
            scheduleSave(activeGameId, [...liveMarkedCells]);
        });
    });

    updateYears();
    initIcons();
    requestAnimationFrame(() => {
        debugPlayOverflow("play-board");
    });
}

function checkBingoWin(marked, size) {
    for (let r = 0; r < size; r++) {
        if (Array.from({ length: size }, (_, c) => marked[r * size + c]).every(Boolean)) return true;
    }
    for (let c = 0; c < size; c++) {
        if (Array.from({ length: size }, (_, r) => marked[r * size + c]).every(Boolean)) return true;
    }
    if (Array.from({ length: size }, (_, i) => marked[i * size + i]).every(Boolean)) return true;
    if (Array.from({ length: size }, (_, i) => marked[i * size + (size - 1 - i)]).every(Boolean)) return true;
    return false;
}

function checkFullGridWin(marked) {
    return Array.isArray(marked) && marked.length > 0 && marked.every(Boolean);
}

function scheduleSave(id, cells) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveMarkedCells(id, cells), 800);
}

async function saveMarkedCells(id, cells) {
    if (!currentUser || !id) return;
    try {
        await updateDoc(bingoDocRef(id), { markedCells: cells, updatedAt: serverTimestamp() });
    } catch (err) {
        console.error("Save error:", err);
    }
}

async function ensureAnonymousProfileAvatar(user) {
    if (!user?.isAnonymous || user.photoURL || guestAvatarGenerationInFlight) return;
    guestAvatarGenerationInFlight = true;
    try {
        const seed = String(user.uid || `guest-${Date.now()}`).slice(0, 24);
        await updateProfile(user, {
            displayName: user.displayName || "Invité",
            photoURL: `https://api.dicebear.com/9.x/glass/svg?seed=${encodeURIComponent(seed)}&radius=0`
        });
        currentUser = auth.currentUser || user;
    } catch (err) {
        console.warn("Guest avatar generation failed", err);
    } finally {
        guestAvatarGenerationInFlight = false;
    }
}


onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) {
        void ensureAnonymousProfileAvatar(user).then(() => restoreAppState());
    } else {
        resetPendingProfilePhotoState();
        void renderLoginView();
    }
});

async function restoreAppState() {
    const storedState = readStoredJson(VIEW_STATE_STORAGE_KEY);

    if (!storedState || storedState.name === "login") {
        await renderDashboard();
        return;
    }

    if (storedState.name === "create") {
        await renderCreateView(storedState.editId || null);
        restoreScrollPosition(storedState.scrollY || 0);
        return;
    }

    if (storedState.name === "play" && storedState.bingoId) {
        await renderPlayView(storedState.bingoId);
        restoreScrollPosition(storedState.scrollY || 0);
        return;
    }

    if (storedState.name === "account") {
        await renderAccountView();
        restoreScrollPosition(storedState.scrollY || 0);
        return;
    }

    await renderDashboard(storedState.filterCategory || null, storedState.searchQuery || "");
    restoreScrollPosition(storedState.scrollY || 0);
}

getRedirectResult(auth).catch(err => {
    if (err && err.code && err.code !== "auth/no-auth-event") {
        logAuthError("la connexion", err, err?.providerId || null, { mode: "redirect-result" });
    }
});


initCookieBanner();
updateYears();
bindCrossPageHeaderTransitions();
window.addEventListener("beforeunload", () => {
    persistCurrentScrollPosition();
    persistCreateDraftIfNeeded();
});
window.addEventListener("pagehide", persistCreateDraftIfNeeded);
window.addEventListener("resize", updateDashboardSearchPlaceholder);
