import {
    db,
    collection,
    doc,
    addDoc,
    getDocs,
    getDoc,
    setDoc,
    deleteDoc,
    query,
    orderBy,
    where,
    limit
} from "./firebase-client.js";
import { currentUser } from "./session.js";
import { handleFirestoreError } from "./errors.js";

export const MAX_BINGOS = 50;

export function bingoCollRef() {
    return collection(db, `users/${currentUser.uid}/bingos`);
}

export function bingoDocRef(id) {
    return doc(db, `users/${currentUser.uid}/bingos/${id}`);
}

export function publicBingoDocRef(id) {
    return doc(db, `publicBingos/${id}`);
}

export function sharedBingoDocRef(id) {
    return doc(db, `sharedBingos/${id}`);
}

function bingoPublicData(bingo) {
    return {
        title: bingo.title,
        category: bingo.category,
        categoryColor: bingo.categoryColor || "#CC0000",
        categoryPattern: bingo.categoryPattern || "none",
        categoryPatternZoom: bingo.categoryPatternZoom || 1,
        size: bingo.size,
        cells: bingo.cells,
        markedCells: new Array(bingo.size * bingo.size).fill(false),
        published: true
    };
}

export async function publishBingo(bingo) {
    const ref = publicBingoDocRef(bingo.id);
    const existing = await getDoc(ref);
    const existingData = existing.exists() ? existing.data() : null;
    const existingMarkedCells = existingData?.markedCells;
    const markedCells = Array.isArray(existingMarkedCells)
        && existingMarkedCells.length === bingo.size * bingo.size
        ? existingMarkedCells
        : new Array(bingo.size * bingo.size).fill(false);
    await setDoc(ref, {
        ...bingoPublicData(bingo),
        markedCells,
        ownerUid: currentUser.uid,
        sourceBingoId: bingo.id,
        publishedAt: existingData?.publishedAt || bingo.publishedAt || new Date(),
        updatedAt: new Date()
    });
}

export async function unpublishBingo(id) {
    await deleteDoc(publicBingoDocRef(id));
}

export async function createShareLink(bingo) {
    const shareRef = await addDoc(collection(db, "sharedBingos"), {
        ...bingoPublicData(bingo),
        ownerUid: currentUser.uid,
        sourceBingoId: bingo.id,
        createdAt: new Date()
    });
    return shareRef.id;
}

export async function fetchPublicBingos() {
    const snap = await getDocs(query(collection(db, "publicBingos"), orderBy("publishedAt", "desc"), limit(100)));
    return snap.docs.map(d => ({ id: d.id, ...d.data(), source: "public" }));
}

export async function fetchSharedBingo(id) {
    const snap = await getDoc(sharedBingoDocRef(id));
    return snap.exists() ? { id: snap.id, ...snap.data(), source: "shared" } : null;
}

export async function fetchPublicBingo(id) {
    const snap = await getDoc(publicBingoDocRef(id));
    return snap.exists() ? { id: snap.id, ...snap.data(), source: "public" } : null;
}


export async function fetchBingos(filterCategory = null) {
    try {
        const constraints = [orderBy("createdAt", "desc"), limit(MAX_BINGOS)];
        if (filterCategory) constraints.unshift(where("category", "==", filterCategory));
        const snap = await getDocs(query(bingoCollRef(), ...constraints));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        handleFirestoreError(err);
        return [];
    }
}

export async function fetchAllCategories() {
    try {
        const snap = await getDocs(query(bingoCollRef(), orderBy("createdAt", "desc"), limit(MAX_BINGOS)));
        return [...new Set(snap.docs.map(d => d.data().category).filter(Boolean))];
    } catch {
        return [];
    }
}
