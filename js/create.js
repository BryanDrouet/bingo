import { addDoc, getDoc, updateDoc, serverTimestamp } from "./firebase-client.js";
import { CREATE_DRAFT_STORAGE_KEY, currentViewState, readStoredJson, writeStoredJson, removeStoredItem, setCurrentViewState } from "./view-state.js";
import { animateElementIn, replaceAppMarkup, navigateWithHeader, initIcons, showToast, escapeHtml } from "./ui.js";
import { MAX_BINGOS, bingoCollRef, bingoDocRef, fetchBingos } from "./bingos.js";
import {
    normalizeHexColor,
    getSmallestPatternZoom,
    normalizeCategoryPatternKey,
    buildCategoryPatternOptions,
    applyPatternPreview,
    buildCategoryInlineStyle,
    normalizeCategoryName,
    isDefaultCategoryName,
    buildCategoryRegistry,
    buildHeaderTagMarkup,
    applyBodyAccentTheme,
    resetBodyAccentTheme
} from "./categories.js";
import { getFriendlyErrorDetails, logStyledError } from "./errors.js";
import { renderDashboard } from "./dashboard.js";

function readCreateDraft(editId) {
    const draft = readStoredJson(CREATE_DRAFT_STORAGE_KEY);
    if (!draft) return null;
    return (draft.editId || null) === (editId || null) ? draft : null;
}

function saveCreateDraft(editId) {
    const size = parseInt(document.getElementById("f-size")?.value, 10) || 3;
    const cells = Array.from({ length: size * size }, (_, i) => document.getElementById(`cell-${i}`)?.value || "");
    const categoryValue = getCreateCategoryValue();
    const categoryColor = getCreateCategoryColorValue();
    const categoryPattern = getCreateCategoryPatternValue();

    writeStoredJson(CREATE_DRAFT_STORAGE_KEY, {
        editId: editId || null,
        title: document.getElementById("f-title")?.value || "",
        category: categoryValue || "",
        categoryColor,
        categoryPattern,
        size,
        cells
    });
}

function getCreateCategoryValue() {
    const select = document.getElementById("f-category-select");
    if (!select) return document.getElementById("f-category")?.value || "";
    if (select.value !== "__new__") return select.value || "";
    return document.getElementById("f-category-new")?.value || "";
}

function getCreateCategoryColorValue() {
    return normalizeHexColor(document.getElementById("f-category-color")?.value, "#CC0000");
}

function getCreateCategoryPatternValue() {
    return normalizeCategoryPatternKey(document.getElementById("f-category-pattern")?.value, "none");
}

function clearCreateDraft(editId = null) {
    const draft = readStoredJson(CREATE_DRAFT_STORAGE_KEY);
    if (!draft || (draft.editId || null) !== (editId || null)) return;
    removeStoredItem(CREATE_DRAFT_STORAGE_KEY);
}

export function persistCreateDraftIfNeeded() {
    if (currentViewState?.name !== "create") return;
    saveCreateDraft(currentViewState.editId || null);
}


export async function renderCreateView(editId = null) {
    resetBodyAccentTheme();
    setCurrentViewState({ name: "create", editId: editId || null, bingoId: null, filterCategory: null });
    await replaceAppMarkup(`
        <div class="view view-create">
            <header class="app-header">
                <div class="header-left">
                    <button type="button" id="back-btn" class="btn btn--ghost-light btn--icon btn--round" aria-label="Retour">
                        <i data-lucide="arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="header-title-group">
                        <span class="header-main-text">Bingo</span>
                        ${buildHeaderTagMarkup(editId ? "Modifier" : "Créer")}
                    </div>
                </div>
            </header>
            <main class="create-body">
                <div class="loading-state"><div class="loading-spinner"></div></div>
            </main>
        </div>
    `);
    document.getElementById("back-btn")?.addEventListener("click", () => {
        void navigateWithHeader(() => renderDashboard());
    });
    initIcons();

    let existing = null;
    if (editId) {
        try {
            const snap = await getDoc(bingoDocRef(editId));
            if (snap.exists()) existing = { id: snap.id, ...snap.data() };
        } catch {
            showToast("Erreur lors du chargement.", "error");
            await renderDashboard();
            return;
        }
    }

    const draft = readCreateDraft(editId);
    const allBingos = await fetchBingos();
    const categoryRegistry = buildCategoryRegistry(allBingos);
    const categories = categoryRegistry.list.map(entry => entry.name);
    const selectedCategory = draft?.category ?? existing?.category ?? "";
    const normalizedSelectedCategory = normalizeCategoryName(selectedCategory);
    const selectedCategoryEntry = categoryRegistry.byKey[normalizedSelectedCategory] || null;
    const effectiveSelectedCategory = selectedCategoryEntry?.name || selectedCategory;
    const hasCustomCategory = !!effectiveSelectedCategory && !selectedCategoryEntry;
    const selectedCategoryValue = hasCustomCategory ? "__new__" : (selectedCategoryEntry?.name || "");
    const selectedCategoryColor = normalizeHexColor(
        selectedCategoryEntry?.color ?? draft?.categoryColor ?? existing?.categoryColor ?? "#CC0000"
    );
    const selectedCategoryPattern = normalizeCategoryPatternKey(
        selectedCategoryEntry?.pattern ?? draft?.categoryPattern ?? existing?.categoryPattern ?? "none",
        "none"
    );
    const size = draft?.size || existing?.size || 3;
    const main = document.querySelector(".view-create .create-body");
    if (!main) return;

    main.innerHTML = `
        <form id="create-form" class="create-form" novalidate>
            <h2 class="form-section-title">${editId ? "Modifier le bingo" : "Nouveau bingo"}</h2>
            <p class="form-required-note">Les champs marqués <span class="required-mark" aria-hidden="true">*</span> sont obligatoires.</p>
            <div class="form-row form-row-2">
                <div class="form-group">
                    <label for="f-title">Titre<span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="f-title" name="f-title"
                                 placeholder="Ex: Nintendo Direct Juin 2026"
                                 value="${draft?.title ?? existing?.title ?? ""}" required maxlength="100"
                                 aria-required="true" aria-describedby="hint-title">
                    <span id="hint-title" class="form-hint">100 caractères max.</span>
                </div>
                <div class="form-group">
                    <label for="f-category-select">Catégorie</label>
                    <select id="f-category-select" name="f-category-select" aria-describedby="hint-cat">
                        <option value="">Sans catégorie</option>
                        ${categories.map(c => `<option value="${escapeHtml(c)}" ${selectedCategoryValue === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
                        <option value="__new__" ${selectedCategoryValue === "__new__" ? "selected" : ""}>Ajouter une catégorie...</option>
                    </select>
                    <input type="text" id="f-category-new" name="f-category-new"
                                 class="${selectedCategoryValue === "__new__" ? "" : "hidden"}"
                                 placeholder="Ex: Nintendo, Gaming, Cinéma"
                                 value="${hasCustomCategory ? effectiveSelectedCategory : ""}" maxlength="50"
                                 aria-describedby="hint-cat">
                    <div class="category-color-config ${selectedCategoryValue === "__new__" ? "" : "hidden"}" id="category-color-config">
                        <label for="f-category-color">Personnalisation de la catégorie</label>
                        <div class="category-personalization-config">
                            <div class="category-color-controls">
                                <input type="color" id="f-category-color" name="f-category-color" value="${selectedCategoryColor}" aria-label="Choisir une couleur de catégorie">
                                <input type="text" id="f-category-color-hex" name="f-category-color-hex" value="${selectedCategoryColor}" maxlength="7" pattern="^#?[A-Fa-f0-9]{3}([A-Fa-f0-9]{3})?$" aria-label="Valeur hexadécimale de la couleur de catégorie">
                            </div>
                            <div class="category-pattern-config" id="category-pattern-config">
                                <label for="f-category-pattern">Motif de fond</label>
                                <select id="f-category-pattern" name="f-category-pattern" aria-label="Choisir un motif de fond pour la catégorie">
                                    ${buildCategoryPatternOptions(selectedCategoryPattern)}
                                </select>
                            </div>
                            <div class="category-pattern-preview" id="f-category-pattern-preview" aria-hidden="true"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="form-group">
                <label for="f-size">Taille de la grille <span class="required-mark" aria-hidden="true">*</span></label>
                <select id="f-size" name="f-size" aria-describedby="hint-size">
                    <option value="3" ${size === 3 ? "selected" : ""}>3x3 (9 cases)</option>
                    <option value="4" ${size === 4 ? "selected" : ""}>4x4 (16 cases)</option>
                    <option value="5" ${size === 5 ? "selected" : ""}>5x5 (25 cases)</option>
                </select>
            </div>
            <div class="form-group">
                <span class="cells-label">Contenu des cases <span class="required-mark" aria-hidden="true">*</span></span>
                <span class="form-hint">Toutes les cases sont obligatoires.</span>
                <div id="cells-editor" class="cells-grid-editor cells-editor-${size}">
                    ${buildCellInputs(size, draft?.cells || existing?.cells)}
                </div>
            </div>
            <div class="form-actions">
                <button type="button" id="cancel-btn" class="btn btn--neutral">Annuler</button>
                <button type="submit" class="btn btn--primary">
                    ${editId ? "Enregistrer les modifications" : "Créer le bingo"}
                </button>
            </div>
        </form>
    `;
    animateElementIn(main.querySelector(".create-form") || main);

    document.getElementById("cancel-btn")?.addEventListener("click", () => {
        clearCreateDraft(editId);
        void navigateWithHeader(() => renderDashboard());
    });
    document.getElementById("f-size")?.addEventListener("change", e => {
        const newSize = parseInt(e.target.value);
        const editor = document.getElementById("cells-editor");
        if (!editor) return;
        const prevVals = [...editor.querySelectorAll("textarea")].map(t => t.value);
        editor.className = `cells-grid-editor cells-editor-${newSize}`;
        editor.innerHTML = buildCellInputs(newSize, prevVals);
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-select")?.addEventListener("change", e => {
        const customInput = document.getElementById("f-category-new");
        if (!customInput) return;
        const isCustom = e.target.value === "__new__";
        customInput.classList.toggle("hidden", !isCustom);
        if (isCustom) customInput.focus();
        if (!isCustom) {
            const detectedEntry = categoryRegistry.byKey[normalizeCategoryName(e.target.value || "")];
            const detectedColor = detectedEntry?.color;
            if (detectedColor) {
                const colorInput = document.getElementById("f-category-color");
                if (colorInput) colorInput.value = normalizeHexColor(detectedColor);
            }
            const patternSelect = document.getElementById("f-category-pattern");
            if (patternSelect) {
                patternSelect.value = normalizeCategoryPatternKey(detectedEntry?.pattern, "none");
            }
        }
        updateCategoryPreview();
        saveCreateDraft(editId);
    });

    function updateCategoryPreview(source = "picker") {
        const liveTag = document.querySelector(".category-live-tag");
        const select = document.getElementById("f-category-select");
        const customInput = document.getElementById("f-category-new");
        const colorInput = document.getElementById("f-category-color");
        const colorHexInput = document.getElementById("f-category-color-hex");
        const patternSelect = document.getElementById("f-category-pattern");
        const patternPreview = document.getElementById("f-category-pattern-preview");
        if (!colorInput || !colorHexInput || !patternSelect || !select || !customInput) return;

        const isCustom = select.value === "__new__";
        const categoryRaw = isCustom ? customInput.value : select.value;
        const isNoCategory = !String(categoryRaw || "").trim();
        const categoryKey = normalizeCategoryName(categoryRaw);
        const matchedEntry = categoryRegistry.byKey[categoryKey] || null;
        const shouldLockColor = !!matchedEntry || !isCustom;
        const categoryColorConfig = document.getElementById("category-color-config");

        const normalizedColor = normalizeHexColor(colorInput.value, "#CC0000");
        const resolvedColor = shouldLockColor
            ? normalizeHexColor(matchedEntry?.color || "#CC0000")
            : normalizedColor;
        const resolvedPattern = shouldLockColor
            ? normalizeCategoryPatternKey(matchedEntry?.pattern, "none")
            : normalizeCategoryPatternKey(patternSelect.value, "none");

        colorInput.value = resolvedColor;
        if (source !== "hex" || document.activeElement !== colorHexInput || shouldLockColor) {
            colorHexInput.value = resolvedColor;
        }
        colorInput.disabled = shouldLockColor;
        colorHexInput.disabled = shouldLockColor;
        patternSelect.disabled = shouldLockColor;
        patternSelect.value = resolvedPattern;
        const zoom = getSmallestPatternZoom(resolvedPattern);
        applyPatternPreview(patternPreview, resolvedPattern, {
            color: resolvedColor,
            zoom
        });
        if (categoryColorConfig) {
            categoryColorConfig.classList.toggle("hidden", shouldLockColor);
        }

        // Keep the global default background when "Sans catégorie" is selected.
        if (isNoCategory) {
            resetBodyAccentTheme();
        } else {
            applyBodyAccentTheme(resolvedColor, resolvedPattern, zoom);
        }

        if (liveTag) {
            liveTag.textContent = getCreateCategoryValue().trim() || "Sans catégorie";
            if (isNoCategory) {
                liveTag.style.cssText = "";
            } else {
                liveTag.style.cssText = buildCategoryInlineStyle(resolvedColor, resolvedPattern, zoom);
            }
        }
    }

    document.getElementById("f-category-new")?.addEventListener("input", () => {
        updateCategoryPreview();
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color")?.addEventListener("input", () => {
        updateCategoryPreview("picker");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color")?.addEventListener("change", () => {
        updateCategoryPreview("picker");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color-hex")?.addEventListener("input", e => {
        const candidate = normalizeHexColor(e.target.value, "");
        if (!candidate) return;
        const colorInput = document.getElementById("f-category-color");
        if (colorInput) colorInput.value = candidate;
        updateCategoryPreview("hex");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-color-hex")?.addEventListener("blur", e => {
        const normalized = normalizeHexColor(e.target.value, "#CC0000");
        e.target.value = normalized;
        const colorInput = document.getElementById("f-category-color");
        if (colorInput) colorInput.value = normalized;
        updateCategoryPreview("hex");
        saveCreateDraft(editId);
    });
    document.getElementById("f-category-pattern")?.addEventListener("change", () => {
        updateCategoryPreview("pattern");
        saveCreateDraft(editId);
    });

    updateCategoryPreview();
    document.getElementById("create-form")?.addEventListener("input", () => saveCreateDraft(editId));
    document.getElementById("create-form")?.addEventListener("change", () => saveCreateDraft(editId));
    document.getElementById("create-form")?.addEventListener("submit", e => handleSaveBingo(e, editId));
    initIcons();
}

function buildCellInputs(size, values) {
    return Array.from({ length: size * size }, (_, i) => `
        <div class="cell-editor-wrap">
            <label for="cell-${i}">Case ${i + 1}</label>
            <textarea id="cell-${i}" name="cell-${i}" rows="2" maxlength="80"
                                placeholder="Saisir le contenu" aria-label="Contenu obligatoire de la case ${i + 1} du bingo, 80 caractères maximum" required aria-required="true">${values?.[i] || ""}</textarea>
        </div>
    `).join("");
}

async function handleSaveBingo(e, editId) {
    e.preventDefault();
    const title = document.getElementById("f-title")?.value.trim();
    const rawCategory = getCreateCategoryValue().trim();
    let category = rawCategory || "Sans catégorie";
    let categoryColor = getCreateCategoryColorValue();
    let categoryPattern = getCreateCategoryPatternValue();
    let categoryPatternZoom = getSmallestPatternZoom(categoryPattern);
    if (!rawCategory) categoryPattern = "none";
    if (!rawCategory) categoryPatternZoom = getSmallestPatternZoom("none");
    const size = parseInt(document.getElementById("f-size")?.value);

    if (!title) {
        showToast("Le titre est obligatoire.", "warning");
        document.getElementById("f-title")?.focus();
        return;
    }

    if (![3, 4, 5].includes(size)) {
        showToast("La taille de la grille est obligatoire.", "warning");
        document.getElementById("f-size")?.focus();
        return;
    }

    const cells = Array.from({ length: size * size }, (_, i) =>
        document.getElementById(`cell-${i}`)?.value.trim() || ""
    );

    const firstEmptyCellIndex = cells.findIndex(cell => !cell);
    if (firstEmptyCellIndex !== -1) {
        showToast(`La case ${firstEmptyCellIndex + 1} est obligatoire.`, "warning");
        document.getElementById(`cell-${firstEmptyCellIndex}`)?.focus();
        return;
    }

    const submit = document.querySelector("#create-form [type='submit']");
    if (submit) submit.disabled = true;

    try {
        const all = await fetchBingos();
        const categoryRegistry = buildCategoryRegistry(all);
        const rawCategoryKey = normalizeCategoryName(rawCategory);
        const matchedCategory = categoryRegistry.byKey[rawCategoryKey] || null;

        if (rawCategory && isDefaultCategoryName(rawCategory)) {
            showToast("Ce nom de catégorie est réservé par l'interface. Choisissez un autre nom.", "warning");
            document.getElementById("f-category-new")?.focus();
            if (submit) submit.disabled = false;
            return;
        }

        if (matchedCategory) {
            category = matchedCategory.name;
            categoryColor = matchedCategory.color;
            categoryPattern = normalizeCategoryPatternKey(matchedCategory.pattern, "none");
            categoryPatternZoom = getSmallestPatternZoom(categoryPattern);
        }

        const normalize = str => (str || "").trim().toLowerCase();
        const isDuplicate = all.some(b =>
            b.id !== editId &&
            normalize(b.title) === normalize(title) &&
            normalize(b.category) === normalize(category)
        );
        if (isDuplicate) {
            showToast("Un bingo avec ce titre existe déjà dans cette catégorie.", "warning");
            document.getElementById("f-title")?.focus();
            if (submit) submit.disabled = false;
            return;
        }

        if (editId) {
            await updateDoc(bingoDocRef(editId), { title, category, categoryColor, categoryPattern, categoryPatternZoom, size, cells, updatedAt: serverTimestamp() });
            showToast("Bingo modifié avec succès.", "success");
        } else {
            if (all.length >= MAX_BINGOS) {
                showToast(`Limite de ${MAX_BINGOS} bingos atteinte.`, "warning");
                if (submit) submit.disabled = false;
                return;
            }
            await addDoc(bingoCollRef(), {
                title,
                category,
                categoryColor,
                categoryPattern,
                categoryPatternZoom,
                size,
                cells,
                markedCells: new Array(size * size).fill(false),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            showToast("Bingo créé avec succès !", "success");
        }
        clearCreateDraft(editId);
        await navigateWithHeader(() => renderDashboard());
    } catch (err) {
        const details = getFriendlyErrorDetails(err, "la sauvegarde du bingo");
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
        logStyledError("Sauvegarde bingo", err, details, {
            editId: editId || null,
            title,
            category,
            size
        });
        if (submit) submit.disabled = false;
    }
}
