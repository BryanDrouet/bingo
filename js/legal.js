const now = new Date();
const currentYear = String(now.getFullYear());
const dateFr = now.toLocaleDateString("fr-FR");
const HEADER_TRANSITION_MS = 180;

document.querySelectorAll("[data-dyn-year]").forEach((node) => {
    node.textContent = currentYear;
});

document.querySelectorAll("[data-dyn-date]").forEach((node) => {
    node.textContent = dateFr;
});

if (window.lucide) {
    window.lucide.createIcons();
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

function getLegalContentTargets() {
    return [...document.querySelectorAll(".view > :not(.app-header)")];
}

function animateLegalContentIn() {
    const targets = getLegalContentTargets();
    if (!targets.length || prefersReducedMotion()) return;

    targets.forEach(target => {
        target.classList.remove("ui-fade-leave", "ui-fade-enter", "ui-fade-enter-active");
        target.classList.add("ui-fade-enter");
    });

    requestAnimationFrame(() => {
        targets.forEach(target => target.classList.add("ui-fade-enter-active"));
    });

    window.setTimeout(() => {
        targets.forEach(target => target.classList.remove("ui-fade-enter", "ui-fade-enter-active"));
    }, HEADER_TRANSITION_MS + 40);
}

async function animateCurrentHeaderOut() {
    const header = document.querySelector(".app-header");
    if (!header || prefersReducedMotion()) return;
    header.classList.remove("app-header--enter", "app-header--enter-active");
    header.classList.add("app-header--leave");
}

async function animateCurrentLegalViewOut() {
    if (!prefersReducedMotion()) {
        animateCurrentHeaderOut();
        getLegalContentTargets().forEach(target => {
            target.classList.remove("ui-fade-enter", "ui-fade-enter-active");
            target.classList.add("ui-fade-leave");
        });
        await wait(HEADER_TRANSITION_MS);
    }
}

function isModifiedClick(event) {
    return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function bindLegalHeaderTransitions() {
    document.addEventListener("click", async event => {
        const link = event.target.closest("a[href]");
        if (!link || isModifiedClick(event) || link.target === "_blank" || link.hasAttribute("download")) return;

        const url = new URL(link.href, window.location.origin);
        if (url.origin !== window.location.origin) return;

        event.preventDefault();
        await animateCurrentLegalViewOut();
        window.location.href = url.href;
    });
}

animateNewHeaderIn();
animateLegalContentIn();
bindLegalHeaderTransitions();
