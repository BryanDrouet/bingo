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

function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const iconMap = { success: "check-circle", error: "alert-circle", info: "info", warning: "alert-triangle" };
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");
    toast.innerHTML = `<i data-lucide="${iconMap[type] || "info"}" aria-hidden="true"></i><span>${message}</span>`;
    container.appendChild(toast);
    initIcons();
    setTimeout(() => {
        toast.classList.add("toast-hide");
        setTimeout(() => toast.remove(), 280);
    }, 3600);
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


function renderLoginView() {
    const app = document.getElementById("app");
    app.innerHTML = `
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
    `;
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
        await signOut(auth);
    } catch {
        showToast("Erreur lors de la déconnexion.", "error");
    }
}


async function renderDashboard(filterCategory = null) {
    const app = document.getElementById("app");
    const avatarHtml = currentUser.photoURL
        ? `<img src="${currentUser.photoURL}" alt="Photo de profil de ${currentUser.displayName || "utilisateur"}" class="img img--avatar">`
        : "";
    app.innerHTML = `
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
    `;
    document.getElementById("signout-btn")?.addEventListener("click", handleSignOut);
    document.getElementById("create-bingo-btn")?.addEventListener("click", () => renderCreateView());
    updateYears();
    initIcons();

    const [bingos, categories] = await Promise.all([fetchBingos(filterCategory), fetchAllCategories()]);
    renderCategoryFilters(categories, filterCategory);
    renderBingoCards(bingos);
}

function renderCategoryFilters(categories, active) {
    const el = document.getElementById("category-filters");
    if (!el) return;
    const items = [
        `<button type="button" class="chip ${!active ? "is-active" : ""}" data-cat="">Tous</button>`,
        ...categories.map(c => `<button type="button" class="chip ${active === c ? "is-active" : ""}" data-cat="${c}">${c}</button>`)
    ];
    el.innerHTML = items.join("");
    el.querySelectorAll(".chip").forEach(btn => {
        btn.addEventListener("click", () => changeFilter(btn.dataset.cat || null));
    });
}

async function changeFilter(cat) {
    const filters = document.getElementById("category-filters");
    filters?.querySelectorAll(".chip").forEach(c => {
        c.classList.toggle("is-active", (c.dataset.cat || "") === (cat || ""));
    });
    const list = document.getElementById("bingo-list");
    if (list) list.innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div class="loading-spinner"></div></div>`;
    const bingos = await fetchBingos(cat);
    renderBingoCards(bingos);
}

function renderBingoCards(bingos) {
    const el = document.getElementById("bingo-list");
    if (!el) return;
    if (!bingos.length) {
        el.innerHTML = `
            <div class="empty-state">
                <i data-lucide="layout-grid" aria-hidden="true"></i>
                <p>Aucun bingo pour le moment.</p>
                <p>Cliquez sur "Nouveau bingo" pour commencer !</p>
            </div>
        `;
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
    el.querySelectorAll(".js-play").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); renderPlayView(btn.dataset.id); }));
    el.querySelectorAll(".js-edit").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); renderCreateView(btn.dataset.id); }));
    el.querySelectorAll(".js-delete").forEach(btn => btn.addEventListener("click", e => { e.stopPropagation(); handleDeleteBingo(btn.dataset.id); }));
    el.querySelectorAll(".bingo-card").forEach(card => {
        card.addEventListener("click", () => renderPlayView(card.dataset.id));
        card.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); renderPlayView(card.dataset.id); }
        });
    });
    initIcons();
}

function buildMiniPreview(bingo) {
    const size = Math.min(bingo.size, 3);
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
        renderDashboard();
    } catch {
        showToast("Erreur lors de la suppression.", "error");
    }
}


async function renderCreateView(editId = null) {
    const app = document.getElementById("app");
    app.innerHTML = `
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
    `;
    document.getElementById("back-btn")?.addEventListener("click", () => renderDashboard());
    initIcons();

    let existing = null;
    if (editId) {
        try {
            const snap = await getDoc(bingoDocRef(editId));
            if (snap.exists()) existing = { id: snap.id, ...snap.data() };
        } catch {
            showToast("Erreur lors du chargement.", "error");
            renderDashboard();
            return;
        }
    }

    const size = existing?.size || 3;
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
                                 value="${existing?.title || ""}" required maxlength="100"
                                 aria-required="true" aria-describedby="hint-title">
                    <span id="hint-title" class="form-hint">100 caractères max.</span>
                </div>
                <div class="form-group">
                    <label for="f-category">Catégorie</label>
                    <input type="text" id="f-category" name="f-category"
                                 placeholder="Ex: Nintendo, Gaming, Cinéma"
                                 value="${existing?.category || ""}" maxlength="50"
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
                    ${buildCellInputs(size, existing?.cells)}
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

    document.getElementById("cancel-btn")?.addEventListener("click", () => renderDashboard());
    document.getElementById("f-size")?.addEventListener("change", e => {
        const newSize = parseInt(e.target.value);
        const editor = document.getElementById("cells-editor");
        if (!editor) return;
        const prevVals = [...editor.querySelectorAll("textarea")].map(t => t.value);
        editor.className = `cells-grid-editor cells-editor-${newSize}`;
        editor.innerHTML = buildCellInputs(newSize, prevVals);
    });
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
    const category = document.getElementById("f-category")?.value.trim() || "Sans catégorie";
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
        if (editId) {
            await updateDoc(bingoDocRef(editId), { title, category, size, cells, updatedAt: serverTimestamp() });
            showToast("Bingo modifié avec succès.", "success");
        } else {
            const all = await fetchBingos();
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
        renderDashboard();
    } catch {
        showToast("Erreur lors de la sauvegarde.", "error");
        if (submit) submit.disabled = false;
    }
}


async function renderPlayView(bingoId) {
    activeGameId = bingoId;
    hasShownWinModal = false;
    const app = document.getElementById("app");
    app.innerHTML = `
        <div class="view view-play">
            <div class="loading-state" style="flex:1"><div class="loading-spinner"></div></div>
        </div>
    `;

    let bingo;
    try {
        const snap = await getDoc(bingoDocRef(bingoId));
        if (!snap.exists()) {
            showToast("Bingo introuvable.", "error");
            renderDashboard();
            return;
        }
        bingo = { id: snap.id, ...snap.data() };
    } catch {
        showToast("Erreur lors du chargement du bingo.", "error");
        renderDashboard();
        return;
    }

    liveMarkedCells = [...(bingo.markedCells || new Array(bingo.size * bingo.size).fill(false))];
    renderPlayBoard(bingo);
}

function renderPlayBoard(bingo) {
    const app = document.getElementById("app");
    const size = bingo.size;

    app.innerHTML = `
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
    `;

    document.getElementById("back-play-btn")?.addEventListener("click", () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveMarkedCells(activeGameId, [...liveMarkedCells]);
        }
        renderDashboard();
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
        renderPlayBoard(bingo);
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
            if (isWinner && !hasShownWinModal) {
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
        renderDashboard();
    } else {
        renderLoginView();
    }
});

getRedirectResult(auth).catch(err => {
    if (err && err.code && err.code !== "auth/no-auth-event") {
        showToast("Échec de la connexion Google.", "error");
        console.error(err);
    }
});


initCookieBanner();
updateYears();
