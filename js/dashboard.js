import {
    auth,
    storage,
    EmailAuthProvider,
    GoogleAuthProvider,
    OAuthProvider,
    GithubAuthProvider,
    TwitterAuthProvider,
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
    updateDoc,
    deleteDoc,
    serverTimestamp,
    storageRef,
    uploadBytes,
    getDownloadURL,
    deleteObject
} from "./firebase-client.js";
import { currentUser, setCurrentUser } from "./session.js";
import {
    HEADER_TRANSITION_MS,
    wait,
    prefersReducedMotion,
    animateElementIn,
    replaceAppMarkup,
    navigateWithHeader,
    showAppModal,
    initIcons,
    updateYears,
    showToast,
    escapeHtml
} from "./ui.js";
import { setCurrentViewState, clearPersistedAppState } from "./view-state.js";
import {
    getFriendlyErrorDetails,
    getAuthErrorDetails,
    logStyledError,
    logAuthError,
    extractErrorCode
} from "./errors.js";
import {
    normalizeHexColor,
    normalizePatternZoom,
    getSmallestPatternZoom,
    normalizeCategoryPatternKey,
    buildCategoryPatternOptions,
    applyPatternPreview,
    buildCategoryInlineStyle,
    buildBingoAccentStyle,
    normalizeCategoryName,
    isDefaultCategoryName,
    buildCategoryRegistry,
    buildCategoryTagMarkup,
    buildHeaderTagMarkup,
    applyBodyAccentTheme,
    resetBodyAccentTheme
} from "./categories.js";
import {
    MAX_PROFILE_IMAGE_FILE_BYTES,
    PROFILE_AVATAR_OUTPUT_SIZE,
    PROFILE_AVATAR_CROP_BOX_SIZE,
    PROFILE_AVATAR_MIN_ZOOM,
    PROFILE_AVATAR_MAX_ZOOM,
    PROFILE_CROPPER_TRANSITION_MS,
    stripAvatarCropMeta,
    appendAvatarCropMeta,
    renderAvatarImage,
    getDefaultProviderPhotoUrl,
    createGeneratedInitialsAvatarUrl,
    isGeneratedInitialsAvatarUrl,
    isAllowedProfileImageFile,
    readFileAsDataUrl,
    computeCropSelectionFromState,
    getCropOutputMimeType,
    inferAvatarExtension,
    generatedAvatarDataUrlToFile,
    getStoragePathFromPublicUrl
} from "./avatars.js";
import { bingoDocRef, fetchBingos } from "./bingos.js";
import {
    getProviderLabel,
    getProviderFactoryById,
    getLinkedProviderIds,
    hasPasswordProvider,
    formatAuthMethods,
    buildEmailAuthConflictMessage,
    getSignInMethodsForEmailAddress,
    handleSignOut,
    setupProfileMenu
} from "./auth.js";

let renderCreateView = async () => {};
let renderPlayView = async () => {};

export function configureDashboardNavigation({ renderCreate, renderPlay }) {
    renderCreateView = renderCreate;
    renderPlayView = renderPlay;
}

let dashboardAllBingos = [];
let dashboardSearchDebounceTimer = null;
let dashboardSearchMediaQuery = null;
let dashboardCategoryRegistry = { byKey: {}, list: [], colorByName: {} };
let pendingProfilePhotoFile = null;
let pendingProfilePhotoObjectUrl = "";
let pendingProfilePhotoCropState = null;
let pendingProfilePhotoCropMeta = null;
let profileCropperCloseTimer = null;

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

export function updateDashboardSearchPlaceholder() {
    const input = document.getElementById("dashboard-search");
    if (!input) return;
    const isSmallScreen = window.matchMedia("(max-width: 620px)").matches;
    input.placeholder = isSmallScreen
        ? "Rechercher"
        : "Rechercher dans les titres, categories et contenus";
}


export async function renderDashboard(filterCategory = null, searchQuery = "") {
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

export async function renderAccountView() {
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

export function resetPendingProfilePhotoState() {
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
        setCurrentUser(auth.currentUser);

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
