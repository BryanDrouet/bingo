import { db, getDoc, onSnapshot, writeBatch, serverTimestamp } from "./firebase-client.js";
import { currentUser } from "./session.js";
import {
    bingoDocRef,
    publicBingoDocRef,
    fetchPublicBingo,
    fetchSharedBingo,
    createShareLink
} from "./bingos.js";
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
let activeSaveId = null;
let activeCanSave = false;
let activePublicBingoId = null;
let stopPublicBingoSync = null;
let liveMarkedCells = [];
let hasShownWinModal = false;
let hasShownFinalWinModal = false;

function fitBingoCellText() {
    document.querySelectorAll(".bingo-cell span").forEach(span => {
        span.style.fontSize = "";
        span.style.width = "100%";
        span.style.maxHeight = "";
        const cell = span.closest(".bingo-cell");
        if (!cell) return;

        const computed = getComputedStyle(cell);
        const baseSize = parseFloat(getComputedStyle(span).fontSize);
        const minSize = 10;
        const horizontalSpace = cell.clientWidth - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight);
        const verticalSpace = cell.clientHeight - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
        span.style.maxHeight = `${Math.max(0, verticalSpace)}px`;
        let size = baseSize;

        while ((span.scrollWidth > horizontalSpace || span.scrollHeight > verticalSpace) && size > minSize) {
            size = Math.max(minSize, size - 0.25);
            span.style.fontSize = `${size}px`;
        }
    });
}

function debugPlayOverflow(source) {
    const view = document.querySelector(".view-play");
    const playBody = document.querySelector(".view-play .play-body");
    const board = document.querySelector(".view-play .bingo-board-wrap");
    const grid = document.querySelector(".view-play .bingo-grid-play");
    if (!view || !playBody || !board || !grid) return;

    const overflowY = Math.max(0, Math.round(playBody.scrollHeight - playBody.clientHeight));
    const metrics = {
        source,
        viewportHeight: window.innerHeight,
        playBodyScrollHeight: playBody.scrollHeight,
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

export async function renderPlayView(bingoId, source = "owned") {
    stopPublicBingoSync?.();
    stopPublicBingoSync = null;
    setCurrentViewState({ name: "play", bingoId, bingoSource: source, editId: null, filterCategory: null });
    const currentPlayMain = document.querySelector(".view-play .play-body");
    if (currentPlayMain) currentPlayMain.scrollTop = 0;
    activeGameId = bingoId;
    activeSaveId = bingoId;
    activeCanSave = source === "owned";
    activePublicBingoId = null;
    hasShownWinModal = false;
    hasShownFinalWinModal = false;

    let bingo;
    let saveId = bingoId;
    let canSave = source === "owned";
    try {
        if (source === "public") {
            bingo = await fetchPublicBingo(bingoId);
        } else if (source === "shared") {
            bingo = await fetchSharedBingo(bingoId);
        } else {
            const snap = await getDoc(bingoDocRef(bingoId));
            bingo = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        }
        if (!bingo) {
            showToast("Bingo introuvable.", "error");
            await renderDashboard();
            return;
        }
        if (source === "public" && currentUser && bingo.ownerUid === currentUser.uid && bingo.sourceBingoId) {
            saveId = bingo.sourceBingoId;
            canSave = true;
            activeSaveId = saveId;
            activeCanSave = true;
            const ownerSnap = await getDoc(bingoDocRef(saveId));
            if (ownerSnap.exists()) {
                const storedMarkedCells = ownerSnap.data().markedCells;
                const ownerMarkedCells = Array.isArray(storedMarkedCells)
                    && storedMarkedCells.length === bingo.size * bingo.size
                    ? storedMarkedCells
                    : new Array(bingo.size * bingo.size).fill(false);
                if (!currentUser.isAnonymous
                    && JSON.stringify(ownerMarkedCells) !== JSON.stringify(bingo.markedCells || [])) {
                    await updatePublicBingoMarks(bingoId, ownerMarkedCells);
                }
                bingo = { ...bingo, markedCells: ownerMarkedCells };
            }
            if (!currentUser.isAnonymous) activePublicBingoId = bingoId;
        }
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
    await renderPlayBoard(bingo, source, saveId, canSave);
    if (source === "public") subscribeToPublicBingo(bingo);
}

async function renderPlayBoard(bingo, source = "owned", saveId = bingo.id, canSave = source === "owned") {
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
                    <button type="button" id="share-play-btn" class="btn btn--ghost-light btn--sm play-share-btn" aria-label="Partager ce bingo" title="Partager ce bingo par lien">
                        <i data-lucide="share-2" aria-hidden="true"></i>
                        <span>Partager</span>
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
            saveTimer = null;
            saveMarkedCells(activeSaveId, [...liveMarkedCells], activeCanSave, activePublicBingoId);
        }
        stopPublicBingoSync?.();
        stopPublicBingoSync = null;
        void navigateWithHeader(() => renderDashboard());
    });

    document.getElementById("share-play-btn")?.addEventListener("click", async () => {
        try {
            const shareId = source === "owned"
                ? await createShareLink(bingo)
                : source === "shared"
                    ? new URLSearchParams(window.location.search).get("share")
                    : null;
            const url = source === "public"
                ? new URL(`?public=${encodeURIComponent(bingo.id)}`, window.location.origin).href
                : new URL(`?share=${encodeURIComponent(shareId)}`, window.location.origin).href;
            if (typeof navigator.share === "function") {
                try {
                    await navigator.share({ title: bingo.title, text: `Joue à mon bingo « ${bingo.title} »`, url });
                    return;
                } catch (shareError) {
                    if (shareError?.name === "AbortError") return;
                }
            }
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(url);
                    showToast("Lien de partage copié.", "success");
                    return;
                } catch (clipboardError) {
                    console.warn("Copie automatique indisponible, affichage du lien à copier manuellement.", clipboardError);
                }
            }
            window.prompt("Copie ce lien pour partager le bingo :", url);
        } catch (err) {
            showToast("Impossible de créer le lien de partage.", "error");
            console.error(err);
        }
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
            scheduleSave(saveId, canSave, activePublicBingoId);
        });
    });

    updateYears();
    initIcons();
    fitBingoCellText();
    window.addEventListener("resize", fitBingoCellText, { passive: true });
    requestAnimationFrame(() => {
        fitBingoCellText();
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

function scheduleSave(id, canSave = true, publicBingoId = null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveMarkedCells(id, [...liveMarkedCells], canSave, publicBingoId);
    }, 800);
}

async function saveMarkedCells(id, cells, canSave = true, publicBingoId = null) {
    if (!currentUser || !id || !canSave) return;
    try {
        const batch = writeBatch(db);
        const update = { markedCells: cells, updatedAt: serverTimestamp() };
        batch.update(bingoDocRef(id), update);
        if (publicBingoId) batch.update(publicBingoDocRef(publicBingoId), update);
        await batch.commit();
    } catch (err) {
        console.error("Save error:", err);
    }
}

async function updatePublicBingoMarks(publicBingoId, cells) {
    const batch = writeBatch(db);
    batch.update(publicBingoDocRef(publicBingoId), {
        markedCells: cells,
        updatedAt: serverTimestamp()
    });
    await batch.commit();
}

function subscribeToPublicBingo(bingo) {
    let lastSnapshotCells = [...(bingo.markedCells || new Array(bingo.size * bingo.size).fill(false))];
    stopPublicBingoSync = onSnapshot(publicBingoDocRef(bingo.id), snapshot => {
        if (!snapshot.exists()) return;
        const nextCells = snapshot.data().markedCells;
        if (!Array.isArray(nextCells) || nextCells.length !== bingo.size * bingo.size) return;
        if (nextCells.every((marked, index) => marked === lastSnapshotCells[index])) return;

        const hasPendingLocalChanges = saveTimer !== null;
        const cellsToApply = nextCells.map((marked, index) => (
            hasPendingLocalChanges && liveMarkedCells[index] !== lastSnapshotCells[index]
                ? liveMarkedCells[index]
                : marked
        ));
        lastSnapshotCells = [...nextCells];
        liveMarkedCells = cellsToApply;
        document.querySelectorAll(".bingo-cell").forEach((cell, index) => {
            const marked = Boolean(liveMarkedCells[index]);
            cell.classList.toggle("marked", marked);
            cell.setAttribute("aria-pressed", String(marked));
            cell.setAttribute("aria-label", `${bingo.cells[index] || "Case vide"}, ${marked ? "cochée" : "non cochée"}`);
        });
    }, error => {
        console.error("Public bingo synchronization error:", error);
        showToast("La synchronisation en direct de ce bingo est indisponible.", "error");
    });
}

export async function flushPendingPlaySave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await saveMarkedCells(activeSaveId, [...liveMarkedCells], activeCanSave, activePublicBingoId);
    }
    stopPublicBingoSync?.();
    stopPublicBingoSync = null;
}
