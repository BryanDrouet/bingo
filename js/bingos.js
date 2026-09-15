import {
    db,
    collection,
    doc,
    getDocs,
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
