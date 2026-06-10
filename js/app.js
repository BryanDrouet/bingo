import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
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

    writeStoredJson(CREATE_DRAFT_STORAGE_KEY, {
        editId: editId || null,
        title: document.getElementById("f-title")?.value || "",
        category: categoryValue || "",
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

function isBlockedByClient(err) {
    const msg = (err && (err.message || err.code) || "").toString().toLowerCase();
    return msg.includes("blocked") || msg.includes("network") || msg.includes("unavailable") || msg.includes("failed to fetch");
}

function handleFirestoreError(err) {
    if (isBlockedByClient(err)) {
        showToast("Accès à Firestore bloqué (bloqueur de pubs ?). Désactivez-le pour ce site.", "error");
    } else {
        showToast("Erreur Firestore. Réessayez.", "error");
    }
    console.error(err);
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


async function renderLoginView() {
    setCurrentViewState({ name: "login" });
    await replaceAppMarkup(`
        <div class="view view-login">
            <header class="app-header">
                <div class="header-left">
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        <span class="header-tag">Interactif</span>
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


async function renderDashboard(filterCategory = null, searchQuery = "") {
    setCurrentViewState({ name: "dashboard", filterCategory: filterCategory || null, searchQuery: searchQuery || "", bingoId: null, editId: null });
    const avatarHtml = currentUser.photoURL
        ? `<img src="${currentUser.photoURL}" alt="Photo de profil de ${currentUser.displayName || "utilisateur"}" class="img img--avatar">`
        : "";
    await replaceAppMarkup(`
        <div class="view view-dashboard">
            <header class="app-header">
                <div class="header-left">
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        <span class="header-tag">Interactif</span>
                    </div>
                </div>
                <div class="header-right">
                    ${avatarHtml}
                    <span class="user-display-name" aria-hidden="true">${currentUser.displayName || currentUser.email || ""}</span>
                    <button type="button" id="signout-btn" class="btn btn--ghost-light btn--sm btn--icon" aria-label="Se déconnecter">
                        <i data-lucide="log-out" aria-hidden="true"></i>
                    </button>
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
                        <input type="text" id="dashboard-search" class="dashboard-search-input" value="${searchQuery || ""}" placeholder="Rechercher dans les titres, categories et contenus" autocomplete="off" spellcheck="false">
                        <button type="button" id="clear-dashboard-search" class="btn btn--ghost-light btn--sm">Effacer</button>
                    </div>
                    <button type="button" id="create-bingo-btn" class="btn btn--primary">
                        <i data-lucide="plus" aria-hidden="true"></i>
                        Nouveau bingo
                    </button>
                </div>
                <div class="bingo-cards-grid" id="bingo-list" aria-label="Vos grilles de bingo">
                    <div class="loading-state" style="grid-column:1/-1"><div class="loading-spinner"></div></div>
                </div>
            </main>
        </div>
    `);
    document.getElementById("signout-btn")?.addEventListener("click", handleSignOut);
    document.getElementById("create-bingo-btn")?.addEventListener("click", () => {
        void navigateWithHeader(() => renderCreateView());
    });
    document.getElementById("dashboard-search")?.addEventListener("input", handleDashboardSearchInput);
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
    const categories = [...new Set(dashboardAllBingos.map(b => b.category).filter(Boolean))];
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
                <span class="tag-category">${b.category || "Sans catégorie"}</span>
                <span class="tag-size">${b.size}x${b.size}</span>
            </div>
            <h3 class="bingo-card-title">${b.title}</h3>
            <div aria-hidden="true">${buildMiniPreview(b)}</div>
            <div class="bingo-card-actions">
                <button type="button" class="btn btn--primary btn--sm js-play" data-id="${b.id}" aria-label="Jouer à ${b.title}">Jouer</button>
                <button type="button" class="btn btn--neutral btn--sm btn--icon js-edit" data-id="${b.id}" aria-label="Modifier ${b.title}">
                    <i data-lucide="pencil" aria-hidden="true"></i>
                </button>
                <button type="button" class="btn btn--danger btn--sm btn--icon js-delete" data-id="${b.id}" aria-label="Supprimer ${b.title}">
                    <i data-lucide="trash-2" aria-hidden="true"></i>
                </button>
            </div>
        </article>
    `).join("");
    el.querySelectorAll(".js-play").forEach(btn => btn.addEventListener("click", e => {
        e.stopPropagation();
        void navigateWithHeader(() => renderPlayView(btn.dataset.id));
    }));
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
    return `<div class="mini-grid-container mini-grid-${size}">${cells}</div>`;
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
                        <span class="header-tag">${editId ? "Modifier" : "Créer"}</span>
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
    const categories = await fetchAllCategories();
    const selectedCategory = draft?.category ?? existing?.category ?? "";
    const hasCustomCategory = !!selectedCategory && !categories.includes(selectedCategory);
    const selectedCategoryValue = hasCustomCategory ? "__new__" : selectedCategory;
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
                                 value="${hasCustomCategory ? selectedCategory : ""}" maxlength="50"
                                 aria-describedby="hint-cat">
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
        saveCreateDraft(editId);
    });
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
    const category = getCreateCategoryValue().trim() || "Sans catégorie";
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
            await updateDoc(bingoDocRef(editId), { title, category, size, cells, updatedAt: serverTimestamp() });
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
    } catch {
        showToast("Erreur lors de la sauvegarde.", "error");
        if (submit) submit.disabled = false;
    }
}


async function renderPlayView(bingoId) {
    setCurrentViewState({ name: "play", bingoId, editId: null, filterCategory: null });
    activeGameId = bingoId;
    hasShownWinModal = false;
    hasShownFinalWinModal = false;
    await replaceAppMarkup(`
        <div class="view view-play">
            <div class="loading-state" style="flex:1"><div class="loading-spinner"></div></div>
        </div>
    `, { animateIn: false });

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

    liveMarkedCells = [...(bingo.markedCells || new Array(bingo.size * bingo.size).fill(false))];
    await renderPlayBoard(bingo);
}

async function renderPlayBoard(bingo) {
    const size = bingo.size;

    await replaceAppMarkup(`
        <div class="view view-play">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-play-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour au tableau de bord">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text" title="${bingo.title}">${bingo.title}</span>
                        <span class="header-tag">${bingo.category || "Bingo"}</span>
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
