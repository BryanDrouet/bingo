import {
    auth,
    GoogleAuthProvider,
    OAuthProvider,
    GithubAuthProvider,
    TwitterAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    fetchSignInMethodsForEmail,
    signInAnonymously,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut,
    updateProfile
} from "./firebase-client.js";
import { currentUser, setCurrentUser } from "./session.js";
import {
    replaceAppMarkup,
    showToast,
    showAppModal,
    initIcons,
    updateYears,
    animateCurrentViewOut
} from "./ui.js";
import { setCurrentViewState, clearPersistedAppState } from "./view-state.js";
import { buildHeaderTagMarkup, resetBodyAccentTheme } from "./categories.js";
import { extractErrorCode, logAuthError } from "./errors.js";

let flushPlayState = async () => {};

export function configureAuth({ flushPlayState: flush }) {
    flushPlayState = flush;
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

export function getProviderLabel(providerId) {
    return AUTH_PROVIDER_LABELS[providerId] || String(providerId || "").replace(/\.com$/i, "") || "inconnu";
}

function getProviderKeyById(providerId) {
    return Object.keys(OAUTH_PROVIDERS).find(key => OAUTH_PROVIDERS[key]?.providerId === providerId) || null;
}

export function getProviderFactoryById(providerId) {
    const key = getProviderKeyById(providerId);
    return key ? OAUTH_PROVIDERS[key] : null;
}


export function getLinkedProviderIds(user = currentUser) {
    return [...new Set((user?.providerData || []).map(entry => entry?.providerId).filter(Boolean))];
}

export function hasPasswordProvider(user = currentUser) {
    return getLinkedProviderIds(user).includes("password");
}

function joinWithConjunction(values) {
    const items = [...new Set((values || []).filter(Boolean))];
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} et ${items[1]}`;
    return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

export function formatAuthMethods(methods) {
    return joinWithConjunction((methods || []).map(getProviderLabel));
}

export function buildEmailAuthConflictMessage(methods = [], mode = "signin") {
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

export async function getSignInMethodsForEmailAddress(email) {
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

export async function renderLoginView() {
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

export async function handleSignOut() {
    try {
        await flushPlayState();
        clearPersistedAppState();
        await animateCurrentViewOut();
        await signOut(auth);
    } catch {
        showToast("Erreur lors de la déconnexion.", "error");
    }
}

export function setupProfileMenu({ onAccount, onSignOut } = {}) {
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

let guestAvatarGenerationInFlight = false;

export async function ensureAnonymousProfileAvatar(user) {
    if (!user?.isAnonymous || user.photoURL || guestAvatarGenerationInFlight) return;
    guestAvatarGenerationInFlight = true;
    try {
        const seed = String(user.uid || `guest-${Date.now()}`).slice(0, 24);
        await updateProfile(user, {
            displayName: user.displayName || "Invité",
            photoURL: `https://api.dicebear.com/9.x/glass/svg?seed=${encodeURIComponent(seed)}&radius=0`
        });
        setCurrentUser(auth.currentUser || user);
    } catch (err) {
        console.warn("Guest avatar generation failed", err);
    } finally {
        guestAvatarGenerationInFlight = false;
    }
}
