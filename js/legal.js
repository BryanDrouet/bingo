const now = new Date();
const currentYear = String(now.getFullYear());
const dateFr = now.toLocaleDateString("fr-FR");

document.querySelectorAll("[data-dyn-year]").forEach((node) => {
    node.textContent = currentYear;
});

document.querySelectorAll("[data-dyn-date]").forEach((node) => {
    node.textContent = dateFr;
});

if (window.lucide) {
    window.lucide.createIcons();
}
