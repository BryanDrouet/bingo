import { getDoc, updateDoc, serverTimestamp } from "./firebase-client.js";
import { currentUser } from "./session.js";
import { bingoDocRef } from "./bingos.js";
import { setCurrentViewState } from "./view-state.js";
import { replaceAppMarkup, navigateWithHeader, showAppModal, initIcons, updateYears, showToast } from "./ui.js";
import {
    getSmallestPatternZoom,
    buildBingoAccentStyle,
    normalizeCategoryName,
    buildHeaderTagMarkup,
    applyBodyAccentTheme,
    resetBodyAccentTheme
} from "./categories.js";
import { renderDashboard } from "./dashboard.js";

let saveTimer = null;
let activeGameId = null;
let liveMarkedCells = [];
let hasShownWinModal = false;
let hasShownFinalWinModal = false;

function debugPlayOverflow(source) {
    const root = document.documentElement;
    const view = document.querySelector(".view-play");
    const playBody = document.querySelector(".view-play .play-body");
    const board = document.querySelector(".view-play .bingo-board-wrap");
    const grid = document.querySelector(".view-play .bingo-grid-play");
    if (!root || !view || !playBody || !board || !grid) return;

    const overflowY = Math.max(0, Math.round(root.scrollHeight - window.innerHeight));
    const metrics = {
        source,
        viewportHeight: window.innerHeight,
        documentScrollHeight: root.scrollHeight,
        overflowY,
        viewHeight: Math.round(view.getBoundingClientRect().height),
        playBodyHeight: Math.round(playBody.getBoundingClientRect().height),
        boardHeight: Math.round(board.getBoundingClientRect().height),
        gridHeight: Math.round(grid.getBoundingClientRect().height)
    };

    const culprit = overflowY > 0
        ? ([grid, board, playBody].find(el => el.scrollHeight - el.clientHeight > 1) || grid)
        : null;

    console.info("[bingo-overflow-debug]", {
        ...metrics,
        culprit: culprit?.className || null
    });
}

export async function renderPlayView(bingoId) {
    setCurrentViewState({ name: "play", bingoId, editId: null, filterCategory: null });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    activeGameId = bingoId;
    hasShownWinModal = false;
    hasShownFinalWinModal = false;

    let bingo;
    try {
        const snap = await getDoc(bingoDocRef(bingoId));
        if (!snap.exists()) {
            showToast("Bingo introuvable.", "error");
            await renderDashboard();
            return;
        }
        bingo = { id: snap.id, ...snap.data() };
    } catch {
        showToast("Erreur lors du chargement du bingo.", "error");
        await renderDashboard();
        return;
    }

    const isNoCategoryBingo = normalizeCategoryName(bingo.category) === normalizeCategoryName("Sans catégorie");
    if (isNoCategoryBingo) {
        resetBodyAccentTheme();
    } else {
        applyBodyAccentTheme(
            bingo.categoryColor,
            bingo.categoryPattern,
            getSmallestPatternZoom(bingo.categoryPattern)
        );
    }
    liveMarkedCells = [...(bingo.markedCells || new Array(bingo.size * bingo.size).fill(false))];
    await renderPlayBoard(bingo);
}

async function renderPlayBoard(bingo) {
    const size = bingo.size;

    await replaceAppMarkup(`
        <div class="view view-play" style="${buildBingoAccentStyle(bingo.categoryColor)}">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-play-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour au tableau de bord">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text" title="${bingo.title}">${bingo.title}</span>
                        ${buildHeaderTagMarkup(bingo.category || "Bingo")}
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
    `);

    document.getElementById("back-play-btn")?.addEventListener("click", () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveMarkedCells(activeGameId, [...liveMarkedCells]);
        }
        void navigateWithHeader(() => renderDashboard());
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
        hasShownFinalWinModal = false;
        await renderPlayBoard(bingo);
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
            const isFullGridWinner = checkFullGridWin(liveMarkedCells);

            if (isFullGridWinner && !hasShownFinalWinModal) {
                hasShownFinalWinModal = true;
                hasShownWinModal = true;
                showAppModal({
                    title: "Bingo final !",
                    message: "Incroyable, toute la grille est complete.",
                    confirmText: "Continuer",
                    hideCancel: true
                });
            } else if (isWinner && !hasShownWinModal) {
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
    requestAnimationFrame(() => {
        debugPlayOverflow("play-board");
    });
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

function checkFullGridWin(marked) {
    return Array.isArray(marked) && marked.length > 0 && marked.every(Boolean);
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

export async function flushPendingPlaySave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        await saveMarkedCells(activeGameId, [...liveMarkedCells]);
    }
}
