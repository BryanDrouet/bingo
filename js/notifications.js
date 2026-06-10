(function () {
    "use strict";

    const VARIANTS = {
        success: { icon: "party-popper", title: "Succès" },
        error: { icon: "alert-octagon", title: "Erreur" },
        warning: { icon: "alert-triangle", title: "Attention" },
        info: { icon: "info", title: "Info" }
    };

    const DEFAULT_DURATION = 4200;
    const MAX_VISIBLE = 4;

    function prefersReducedMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    function getContainer() {
        let container = document.getElementById("toast-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "toast-container";
            container.setAttribute("aria-live", "polite");
            container.setAttribute("aria-atomic", "false");
            document.body.appendChild(container);
        }
        container.classList.add("toast-container");
        return container;
    }

    function refreshIcons() {
        if (window.lucide && typeof window.lucide.createIcons === "function") {
            window.lucide.createIcons();
        }
    }

    function dismiss(toast) {
        if (!toast || toast.dataset.closing === "true") return;
        toast.dataset.closing = "true";
        toast.classList.add("toast--leave");
        const remove = () => toast.remove();
        toast.addEventListener("animationend", remove, { once: true });
        setTimeout(remove, 400);
    }

    function trimOverflow(container) {
        const toasts = container.querySelectorAll(".toast:not(.toast--leave)");
        for (let i = 0; i <= toasts.length - MAX_VISIBLE - 1; i++) {
            dismiss(toasts[i]);
        }
    }

    function notify(message, type = "info", options = {}) {
        const container = getContainer();
        const variant = VARIANTS[type] ? type : "info";
        const config = VARIANTS[variant];
        const duration = typeof options.duration === "number" ? options.duration : DEFAULT_DURATION;
        const title = options.title || config.title;

        const toast = document.createElement("div");
        toast.className = `toast toast--${variant}`;
        toast.setAttribute("role", variant === "error" ? "alert" : "status");

        toast.innerHTML = `
            <span class="toast__icon" aria-hidden="true"><i data-lucide="${config.icon}"></i></span>
            <div class="toast__content">
                <p class="toast__title"></p>
                <p class="toast__message"></p>
            </div>
            <button type="button" class="toast__close" aria-label="Fermer la notification">
                <i data-lucide="x" aria-hidden="true"></i>
            </button>
            <span class="toast__progress" aria-hidden="true"></span>
        `;

        toast.querySelector(".toast__title").textContent = title;
        toast.querySelector(".toast__message").textContent = message;
        toast.querySelector(".toast__close").addEventListener("click", () => dismiss(toast));

        container.appendChild(toast);
        trimOverflow(container);
        refreshIcons();

        if (duration > 0) {
            const progress = toast.querySelector(".toast__progress");
            const reduced = prefersReducedMotion();
            if (progress && !reduced) {
                progress.style.animationDuration = `${duration}ms`;
            }

            let timer = null;
            let remaining = duration;
            let startedAt = 0;

            const start = () => {
                startedAt = Date.now();
                timer = window.setTimeout(() => dismiss(toast), remaining);
            };
            const pause = () => {
                if (timer === null) return;
                window.clearTimeout(timer);
                timer = null;
                remaining -= Date.now() - startedAt;
                toast.classList.add("toast--paused");
            };
            const resume = () => {
                if (timer !== null || toast.dataset.closing === "true") return;
                toast.classList.remove("toast--paused");
                start();
            };

            start();
            toast.addEventListener("mouseenter", pause);
            toast.addEventListener("mouseleave", resume);
            toast.addEventListener("focusin", pause);
            toast.addEventListener("focusout", resume);
        }

        return toast;
    }

    const api = {
        show: (message, type, options) => notify(message, type, options),
        success: (message, options) => notify(message, "success", options),
        error: (message, options) => notify(message, "error", options),
        warning: (message, options) => notify(message, "warning", options),
        info: (message, options) => notify(message, "info", options),
        dismissAll: () => {
            getContainer().querySelectorAll(".toast").forEach(dismiss);
        }
    };

    window.Notify = api;
    window.showToast = function (message, type = "info", options = {}) {
        return notify(message, type, options);
    };
})();
