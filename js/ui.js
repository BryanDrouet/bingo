import { persistCurrentScrollPosition } from "./view-state.js";

export const HEADER_TRANSITION_MS = 180;

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}


export function getViewContentTargets(root = document) {
    return [...root.querySelectorAll(".view > :not(.app-header)")];
}

export function animateElementsIn(elements) {
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

export function animateElementIn(element) {
    if (!element) return;
    animateElementsIn([element]);
}

export async function animateCurrentHeaderOut() {
    const header = document.querySelector(".app-header");
    if (!header || prefersReducedMotion()) return;
    header.classList.remove("app-header--enter", "app-header--enter-active");
    header.classList.add("app-header--leave");
}

export function animateNewHeaderIn() {
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

export async function animateCurrentViewOut() {
    if (prefersReducedMotion()) return;
    animateCurrentHeaderOut();
    getViewContentTargets().forEach(element => {
        element.classList.remove("ui-fade-enter", "ui-fade-enter-active");
        element.classList.add("ui-fade-leave");
    });
    await wait(HEADER_TRANSITION_MS);
}

export function animateNewViewIn() {
    if (prefersReducedMotion()) return;
    animateNewHeaderIn();
    animateElementsIn(getViewContentTargets());
}

export async function replaceAppMarkup(markup, { animateOut = false, animateIn = true } = {}) {
    const app = document.getElementById("app");
    if (!app) return;
    if (animateOut) await animateCurrentViewOut();
    app.innerHTML = markup;
    if (animateIn) animateNewViewIn();
}

export async function navigateWithHeader(renderFn) {
    persistCurrentScrollPosition();
    await animateCurrentViewOut();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return renderFn();
}

export function isModifiedClick(event) {
    return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

export function isLegalPagePath(pathname) {
    return pathname.startsWith("/mentions-legales/") ||
        pathname.startsWith("/politique-confidentialite/") ||
        pathname.startsWith("/suppression-donnees-utilisateur/") ||
        pathname.startsWith("/conditions-de-service/");
}

export function bindCrossPageHeaderTransitions() {
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

export function getAppModalElements() {
    return {
        root: document.getElementById("app-modal"),
        title: document.getElementById("app-modal-title"),
        message: document.getElementById("app-modal-message"),
        close: document.getElementById("app-modal-close"),
        cancel: document.getElementById("app-modal-cancel"),
        confirm: document.getElementById("app-modal-confirm")
    };
}

export function showAppModal({ title, message, confirmText = "Confirmer", cancelText = "Annuler", confirmVariant = "primary", hideCancel = false }) {
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

export function initIcons() {
    if (window.lucide) window.lucide.createIcons();
}

export function updateYears() {
    document.querySelectorAll(".dyn-year").forEach(el => {
        el.textContent = new Date().getFullYear();
    });
}

export function showToast(message, type = "info", options = {}) {
    if (window.Notify && typeof window.Notify.show === "function") {
        return window.Notify.show(message, type, options);
    }
    console.warn("Système de notifications indisponible:", message);
}

export function initCookieBanner() {
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

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
