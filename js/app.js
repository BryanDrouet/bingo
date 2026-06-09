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

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyC6wMdN5gdEmwKeGmNRSB_56iAsg9EC8r0",
    authDomain: "bingo-37e53.firebaseapp.com",
    projectId: "bingo-37e53",
    storageBucket: "bingo-37e53.firebasestorage.app",
    messagingSenderId: "497573754040",
    appId: "1:497573754040:web:2e0b3f7d7e87eef9fd304d"
};

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

function openPrivacyModal() {
    const modal = document.getElementById("privacy-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const dateEl = document.getElementById("privacy-date");
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString("fr-FR");
    updateYears();
    initIcons();
}

function closePrivacyModal() {
    document.getElementById("privacy-modal")?.classList.add("hidden");
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
    document.getElementById("privacy-link-cookie")?.addEventListener("click", openPrivacyModal);
}

function initPrivacyModal() {
    document.getElementById("close-privacy")?.addEventListener("click", closePrivacyModal);
    document.getElementById("privacy-modal")?.addEventListener("click", e => {
        if (e.target === document.getElementById("privacy-modal")) closePrivacyModal();
    });
    document.getElementById("info-fab")?.addEventListener("click", openPrivacyModal);
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

/* ---- LOGIN VIEW ---- */
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
                        <svg class="img img--icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
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

/* ---- DASHBOARD VIEW ---- */
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
                <button type="button" class="btn btn--primary btn--sm js-play" data-id="${b.id}" aria-label="Jouer à ${b.title}">
                    <i data-lucide="play" aria-hidden="true"></i> Jouer
                </button>
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
    if (!window.confirm("Voulez-vous vraiment supprimer ce bingo ?")) return;
    try {
        await deleteDoc(bingoDocRef(id));
        showToast("Bingo supprimé.", "success");
        renderDashboard();
    } catch {
        showToast("Erreur lors de la suppression.", "error");
    }
}

/* ---- CREATE / EDIT VIEW ---- */
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
            <div class="form-row form-row-2">
                <div class="form-group">
                    <label for="f-title">Titre <span aria-hidden="true">*</span></label>
                    <input type="text" id="f-title" name="f-title"
                                 placeholder="Ex: Nintendo Direct Juin 2026"
                                 value="${existing?.title || ""}" required maxlength="100"
                                 aria-required="true" aria-describedby="hint-title">
                    <span id="hint-title" class="form-hint">100 caractères max. Obligatoire.</span>
                </div>
                <div class="form-group">
                    <label for="f-category">Catégorie</label>
                    <input type="text" id="f-category" name="f-category"
                                 placeholder="Ex: Nintendo, Gaming, Cinéma"
                                 value="${existing?.category || ""}" maxlength="50"
                                 aria-describedby="hint-cat">
                    <span id="hint-cat" class="form-hint">Permet de regrouper vos bingos.</span>
                </div>
            </div>
            <div class="form-group" style="max-width:260px">
                <label for="f-size">Taille de la grille</label>
                <select id="f-size" name="f-size" aria-describedby="hint-size">
                    <option value="3" ${size === 3 ? "selected" : ""}>3x3 (9 cases)</option>
                    <option value="4" ${size === 4 ? "selected" : ""}>4x4 (16 cases)</option>
                    <option value="5" ${size === 5 ? "selected" : ""}>5x5 (25 cases)</option>
                </select>
                <span id="hint-size" class="form-hint">Choisissez la taille de votre grille de bingo.</span>
            </div>
            <div class="form-group">
                <span class="cells-label">Contenu des cases</span>
                <div id="cells-editor" class="cells-grid-editor cells-editor-${size}">
                    ${buildCellInputs(size, existing?.cells)}
                </div>
            </div>
            <div class="form-actions">
                <button type="button" id="cancel-btn" class="btn btn--neutral">Annuler</button>
                <button type="submit" class="btn btn--primary">
                    <i data-lucide="${editId ? "save" : "plus-circle"}" aria-hidden="true"></i>
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
                                placeholder="Case ${i + 1}" aria-label="Contenu de la case ${i + 1}">${values?.[i] || ""}</textarea>
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

    const cells = Array.from({ length: size * size }, (_, i) =>
        document.getElementById(`cell-${i}`)?.value.trim() || ""
    );

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

/* ---- PLAY VIEW ---- */
async function renderPlayView(bingoId) {
    activeGameId = bingoId;
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
    const won = checkBingoWin(liveMarkedCells, size);

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
                <div id="win-banner" class="win-banner${won ? "" : " hidden"}" role="alert" aria-live="assertive">
                    <i data-lucide="trophy" aria-hidden="true"></i>
                    <span>BINGO !</span>
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

    document.getElementById("reset-btn")?.addEventListener("click", () => {
        if (!window.confirm("Réinitialiser toutes les cases cochées ?")) return;
        liveMarkedCells = new Array(bingo.size * bingo.size).fill(false);
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
            const banner = document.getElementById("win-banner");
            if (banner) {
                const won = checkBingoWin(liveMarkedCells, bingo.size);
                banner.classList.toggle("hidden", !won);
                if (won) initIcons();
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

/* ---- AUTH ---- */
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

/* ---- INIT ---- */
initCookieBanner();
initPrivacyModal();
updateYears();
