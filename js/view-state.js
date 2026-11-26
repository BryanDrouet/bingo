export const VIEW_STATE_STORAGE_KEY = "bingo-view-state";
export const CREATE_DRAFT_STORAGE_KEY = "bingo-create-draft";

export let currentViewState = null;

export function readStoredJson(key) {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function writeStoredJson(key, value) {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
}

export function removeStoredItem(key) {
    try {
        sessionStorage.removeItem(key);
    } catch {}
}

export function setCurrentViewState(nextState) {
    currentViewState = {
        ...(currentViewState || {}),
        ...nextState,
        scrollY: 0
    };
    writeStoredJson(VIEW_STATE_STORAGE_KEY, currentViewState);
}

export function persistCurrentScrollPosition() {
    if (!currentViewState) return;
    currentViewState = {
        ...currentViewState,
        scrollY: document.querySelector(".view > main")?.scrollTop || 0
    };
    writeStoredJson(VIEW_STATE_STORAGE_KEY, currentViewState);
}

export function restoreScrollPosition(scrollY = 0) {
    if (!scrollY) return;
    window.requestAnimationFrame(() => {
        const main = document.querySelector(".view > main");
        if (main) main.scrollTop = scrollY;
    });
}

export function clearPersistedAppState() {
    currentViewState = null;
    removeStoredItem(VIEW_STATE_STORAGE_KEY);
    removeStoredItem(CREATE_DRAFT_STORAGE_KEY);
}
