import { auth, getRedirectResult, onAuthStateChanged, signInAnonymously } from "./firebase-client.js";
import { setCurrentUser } from "./session.js";
import {
    initCookieBanner,
    updateYears,
    bindCrossPageHeaderTransitions
} from "./ui.js";
import {
    VIEW_STATE_STORAGE_KEY,
    readStoredJson,
    restoreScrollPosition,
    persistCurrentScrollPosition
} from "./view-state.js";
import { logAuthError } from "./errors.js";
import {
    configureAuth,
    renderLoginView,
    ensureAnonymousProfileAvatar
} from "./auth.js";
import {
    configureDashboardNavigation,
    renderDashboard,
    renderAccountView,
    resetPendingProfilePhotoState,
    updateDashboardSearchPlaceholder
} from "./dashboard.js";
import { renderCreateView, persistCreateDraftIfNeeded } from "./create.js";
import { renderPlayView, flushPendingPlaySave } from "./play.js";

configureAuth({ flushPlayState: flushPendingPlaySave });
configureDashboardNavigation({ renderCreate: renderCreateView, renderPlay: renderPlayView });

onAuthStateChanged(auth, user => {
    setCurrentUser(user);
    if (user) {
        void ensureAnonymousProfileAvatar(user).then(() => restoreAppState());
    } else {
        resetPendingProfilePhotoState();
        const params = new URLSearchParams(window.location.search);
        if (params.has("share") || params.has("public")) {
            void signInAnonymously(auth).catch(() => renderLoginView());
        } else {
            void renderLoginView();
        }
    }
});

async function restoreAppState() {
    const storedState = readStoredJson(VIEW_STATE_STORAGE_KEY);
    const params = new URLSearchParams(window.location.search);
    const sharedId = params.get("share");
    const publicId = params.get("public");
    if (sharedId || publicId) {
        await renderPlayView(sharedId || publicId, sharedId ? "shared" : "public");
        return;
    }

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
        await renderPlayView(storedState.bingoId, storedState.bingoSource || "owned");
        restoreScrollPosition(storedState.scrollY || 0);
        return;
    }

    if (storedState.name === "account") {
        await renderAccountView();
        restoreScrollPosition(storedState.scrollY || 0);
        return;
    }

    await renderDashboard(storedState.filterCategory || null, storedState.searchQuery || "", storedState.dashboardMode || "mine");
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
