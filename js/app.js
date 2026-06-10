import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    updateProfile,
    deleteUser,
    reauthenticateWithPopup,
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
let dashboardCategoryRegistry = { byKey: {}, list: [], colorByName: {} };
const HEADER_TRANSITION_MS = 180;
const VIEW_STATE_STORAGE_KEY = "bingo-view-state";
const CREATE_DRAFT_STORAGE_KEY = "bingo-create-draft";

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

    writeStoredJson(CREATE_DRAFT_STORAGE_KEY, {
        editId: editId || null,
        title: document.getElementById("f-title")?.value || "",
        category: categoryValue || "",
        categoryColor,
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
    return pathname.startsWith("/mentions-legales/") || pathname.startsWith("/politique-confidentialite/");
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


async function renderLoginView() {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "login" });
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
                <div class="login-card">
                    <h1>Bienvenue</h1>
                    <p>Connectez-vous avec votre compte Google pour créer et gérer vos grilles de bingo interactives.</p>
                    <button type="button" id="google-signin-btn" class="btn btn--neutral btn--lg btn--block" aria-label="Se connecter avec Google">
                        <img src="/assets/google-favicon-2025.svg" alt="" class="img img--icon" aria-hidden="true">
                        Se connecter avec Google
                    </button>
                </div>
            </div>
        </div>
    `);
    document.getElementById("google-signin-btn")?.addEventListener("click", handleGoogleSignIn);
    updateYears();
    initIcons();
}

async function handleGoogleSignIn() {
    const btn = document.getElementById("google-signin-btn");
    if (btn) btn.disabled = true;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        const code = err && err.code;
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
            if (btn) btn.disabled = false;
            return;
        }
        if (
            code === "auth/popup-blocked" ||
            code === "auth/operation-not-supported-in-this-environment" ||
            code === "auth/web-storage-unsupported" ||
            code === "auth/internal-error" ||
            code === "auth/network-request-failed"
        ) {
            try {
                await signInWithRedirect(auth, provider);
                return;
            } catch (e) {
                console.error(e);
            }
        }
        showToast("Erreur lors de la connexion. Veuillez réessayer.", "error");
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
        ? `<img src="${currentUser.photoURL}" alt="Photo de profil de ${currentUser.displayName || "utilisateur"}" class="img img--avatar">`
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
                            <span class="user-display-name" aria-hidden="true">${currentUser.displayName || currentUser.email || ""}</span>
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

    const displayName = currentUser?.displayName || "";
    const photoUrl = currentUser?.photoURL || "";
    const email = currentUser?.email || "";

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
                <section class="account-card" aria-labelledby="account-profile-title">
                    <h1 id="account-profile-title" class="form-section-title">Profil</h1>
                    <form id="account-profile-form" class="account-form" novalidate>
                        <p class="form-required-note">Modifiez votre pseudo et l'URL de votre photo de profil.</p>
                        <div class="form-row form-row-2">
                            <div class="form-group">
                                <label for="account-display-name">Pseudo</label>
                                <input id="account-display-name" name="accountDisplayName" type="text" maxlength="60" value="${escapeHtml(displayName)}" autocomplete="name" spellcheck="false" placeholder="Votre pseudo">
                            </div>
                            <div class="form-group">
                                <label for="account-photo-url">Photo de profil (URL)</label>
                                <input id="account-photo-url" name="accountPhotoUrl" type="url" value="${escapeHtml(photoUrl)}" autocomplete="url" spellcheck="false" placeholder="https://...">
                            </div>
                        </div>
                        <p class="account-email">Compte connecté: ${escapeHtml(email)}</p>
                        <div class="form-actions">
                            <button type="submit" class="btn btn--primary">Enregistrer le profil</button>
                        </div>
                    </form>
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
        void navigateWithHeader(() => renderDashboard());
    });
    document.getElementById("signout-account-btn")?.addEventListener("click", handleSignOut);
    document.getElementById("account-profile-form")?.addEventListener("submit", handleAccountProfileSubmit);
    document.getElementById("purge-data-btn")?.addEventListener("click", handlePurgeUserData);
    document.getElementById("delete-account-btn")?.addEventListener("click", handleDeleteAccount);

    dashboardAllBingos = await fetchBingos();
    dashboardCategoryRegistry = buildCategoryRegistry(dashboardAllBingos);
    renderCategoryManagerPanelIn("account-category-manager", dashboardCategoryRegistry);

    updateYears();
    initIcons();
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
                        <label for="cat-color-${index}">Couleur de la catégorie</label>
                        <div class="category-color-controls">
                            <input type="color" id="cat-color-${index}" class="category-color-swatch" value="${entry.color}" aria-label="Choisir une couleur pour ${escapeHtml(entry.name)}">
                            <input type="text" id="cat-color-hex-${index}" class="category-color-hex" value="${entry.color}" maxlength="7" pattern="^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3})?$" aria-label="Code hexadécimal pour ${escapeHtml(entry.name)}">
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
        if (!nameInput || !colorInput || !hexInput) return;

        const syncAndPreview = source => {
            const color = normalizeHexColor(colorInput.value, "#CC0000");
            colorInput.value = color;
            if (source !== "hex" || document.activeElement !== hexInput) {
                hexInput.value = color;
            }
        };

        const persist = async () => {
            const categoryName = item.dataset.category || "";
            const nextColor = normalizeHexColor(colorInput.value, "#CC0000");
            colorInput.disabled = true;
            hexInput.disabled = true;
            try {
                await updateCategoryColorForName(categoryName, nextColor);
                showToast(`Couleur mise à jour pour ${categoryName}.`, "success");
            } catch (err) {
                const details = getFriendlyErrorDetails(err, "la mise à jour de la catégorie");
                showToast(`${details.userMessage} Voir la console (F12).`, "error");
                logStyledError("Mise à jour catégorie", err, details, { categoryName, nextColor });
            } finally {
                colorInput.disabled = false;
                hexInput.disabled = false;
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
    });
}

async function handleAccountProfileSubmit(event) {
    event.preventDefault();
    if (!currentUser) return;

    const submitButton = event.currentTarget?.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    try {
        const displayName = String(document.getElementById("account-display-name")?.value || "").trim();
        const photoInput = String(document.getElementById("account-photo-url")?.value || "").trim();
        let photoURL = null;

        if (photoInput) {
            const parsed = new URL(photoInput);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("URL de photo invalide");
            }
            photoURL = parsed.toString();
        }

        await updateProfile(currentUser, {
            displayName: displayName || null,
            photoURL
        });

        showToast("Profil mis à jour.", "success");
        await renderAccountView();
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la mise à jour du profil");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Mise à jour profil", err, details, {
            displayName: document.getElementById("account-display-name")?.value || "",
            hasPhotoUrl: Boolean(document.getElementById("account-photo-url")?.value)
        });
        if (submitButton) submitButton.disabled = false;
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
        message: "Le compte Google lié à Bingo et toutes vos données Bingo seront supprimés définitivement. Il ne s'agit pas d'un bannissement : vous pourrez recréer un compte avec la même adresse Google en vous reconnectant.",
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
            const provider = new GoogleAuthProvider();
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

function buildCategoryInlineStyle(color) {
    const base = normalizeHexColor(color);
    return [
        `--category-color:${base}`,
        `--category-color-dark:${darkenHexColor(base, 22)}`,
        `--category-bg:${hexToRgba(base, 0.6)}`,
        `--category-border:${hexToRgba(base)}`,
        `--category-text:${getReadableTextColor(base)}`
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
        const entry = { name, key, color };
        byKey[key] = entry;
        list.push(entry);
    });
    return {
        byKey,
        list,
        colorByName: Object.fromEntries(list.map(entry => [entry.name, entry.color]))
    };
}

function buildCategoryTagMarkup(category, color, extraClass = "") {
    const className = ["tag-category", extraClass].filter(Boolean).join(" ");
    return `<span class="${className}" style="${buildCategoryInlineStyle(color)}">${escapeHtml(category || "Sans catégorie")}</span>`;
}

function buildHeaderTagMarkup(text) {
    return `<span class="header-tag header-tag-live">${escapeHtml(text || "Bingo")}</span>`;
}

function applyBodyAccentTheme(color) {
    const body = document.body;
    if (!body) return;
    const base = normalizeHexColor(color, "#CC0000");
    const onBase = getReadableTextColor(base);
    const isLightBase = onBase === "#111111";

    body.style.setProperty("--theme-red", base);
    body.style.setProperty("--theme-red-dark", darkenHexColor(base, 22));
    body.style.setProperty("--theme-error", isLightBase ? darkenHexColor(base, 55) : base);
    body.style.setProperty("--theme-on-red", onBase);
    body.style.setProperty("--theme-on-red-soft", hexToRgba(onBase, 0.72));
    body.style.setProperty("--header-tag-bg", base);
    body.style.setProperty("--header-tag-text", onBase);
}

function resetBodyAccentTheme() {
    const body = document.body;
    if (!body) return;
    body.style.removeProperty("--theme-red");
    body.style.removeProperty("--theme-red-dark");
    body.style.removeProperty("--theme-error");
    body.style.removeProperty("--theme-on-red");
    body.style.removeProperty("--theme-on-red-soft");
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
                ${buildCategoryTagMarkup(b.category, b.categoryColor)}
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
                        <label for="f-category-color">Couleur de la catégorie</label>
                        <div class="category-color-controls">
                            <input type="color" id="f-category-color" name="f-category-color" value="${selectedCategoryColor}" aria-label="Choisir une couleur de catégorie">
                            <input type="text" id="f-category-color-hex" name="f-category-color-hex" value="${selectedCategoryColor}" maxlength="7" pattern="^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3})?$" aria-label="Valeur hexadécimale de la couleur de catégorie">
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
            const detectedColor = categoryRegistry.byKey[normalizeCategoryName(e.target.value || "")]?.color;
            if (detectedColor) {
                const colorInput = document.getElementById("f-category-color");
                if (colorInput) colorInput.value = normalizeHexColor(detectedColor);
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
        if (!colorInput || !colorHexInput || !select || !customInput) return;

        const isCustom = select.value === "__new__";
        const categoryRaw = isCustom ? customInput.value : select.value;
        const categoryKey = normalizeCategoryName(categoryRaw);
        const matchedEntry = categoryRegistry.byKey[categoryKey] || null;
        const shouldLockColor = !!matchedEntry || !isCustom;
        const categoryColorConfig = document.getElementById("category-color-config");

        const normalizedColor = normalizeHexColor(colorInput.value, "#CC0000");
        const resolvedColor = shouldLockColor
            ? normalizeHexColor(matchedEntry?.color || "#CC0000")
            : normalizedColor;

        colorInput.value = resolvedColor;
        if (source !== "hex" || document.activeElement !== colorHexInput || shouldLockColor) {
            colorHexInput.value = resolvedColor;
        }
        colorInput.disabled = shouldLockColor;
        colorHexInput.disabled = shouldLockColor;
        if (categoryColorConfig) {
            categoryColorConfig.classList.toggle("hidden", shouldLockColor);
        }

        // Live theme preview for the whole create page while editing color.
        applyBodyAccentTheme(resolvedColor);

        if (liveTag) {
            liveTag.textContent = getCreateCategoryValue().trim() || "Sans catégorie";
            liveTag.style.cssText = buildCategoryInlineStyle(resolvedColor);
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
            await updateDoc(bingoDocRef(editId), { title, category, categoryColor, size, cells, updatedAt: serverTimestamp() });
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

    applyBodyAccentTheme(bingo.categoryColor);
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


onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) {
        void restoreAppState();
    } else {
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
        showToast("Échec de la connexion Google.", "error");
        console.error(err);
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
