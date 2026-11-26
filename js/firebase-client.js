import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
    getAuth,
    EmailAuthProvider,
    GoogleAuthProvider,
    OAuthProvider,
    GithubAuthProvider,
    TwitterAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    fetchSignInMethodsForEmail,
    signInAnonymously,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut,
    updateProfile,
    updatePassword,
    deleteUser,
    reauthenticateWithPopup,
    reauthenticateWithCredential,
    linkWithPopup,
    linkWithCredential,
    unlink,
    onAuthStateChanged,
    browserLocalPersistence,
    setPersistence
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
    initializeFirestore,
    collection,
    doc,
    addDoc,
    setDoc,
    getDocs,
    getDoc,
    onSnapshot,
    writeBatch,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    query,
    orderBy,
    where,
    limit
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
    getStorage,
    ref as storageRef,
    uploadBytes,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-storage.js";

const FIREBASE_CONFIG = window.__FIREBASE_CONFIG__ || {};

const REQUIRED_FIREBASE_KEYS = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId"
];

function getMissingFirebaseKeys(config) {
    if (!config || typeof config !== "object") return [...REQUIRED_FIREBASE_KEYS];
    return REQUIRED_FIREBASE_KEYS.filter(k => !config[k]);
}

const missingFirebaseKeys = getMissingFirebaseKeys(FIREBASE_CONFIG);
if (missingFirebaseKeys.length) {
    const app = document.getElementById("app");
    const isLocalDev = window.__IS_LOCAL_DEV__ === true;
    const expectedConfigMessage = isLocalDev
        ? "Vérifiez que js/firebase-config.local.js (ou js/firebase-config.js) contient les six paramètres Firebase requis."
        : "La configuration de déploiement Firebase est absente. Vérifiez les secrets FIREBASE_* dans GitHub > Settings > Secrets and variables > Actions, puis relancez le déploiement.";
    if (app) {
        app.innerHTML = `
            <div class="view view-login">
                <header class="app-header">
                    <div class="header-left">
                        <div class="header-title-group">
                            <span class="header-main-text">Bingo</span>
                            <span class="header-tag header-tag-live">Interactif</span>
                        </div>
                    </div>
                </header>
                <main class="login-body">
                    <div class="login-card">
                        <h1>Configuration manquante</h1>
                        <p>${expectedConfigMessage}</p>
                    </div>
                </main>
            </div>
        `;
        if (window.lucide?.createIcons) window.lucide.createIcons();
    }
    throw new Error(`Firebase config missing keys: ${missingFirebaseKeys.join(", ")}`);
}

export const firebaseApp = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(firebaseApp);
export const storage = getStorage(firebaseApp);
export const db = initializeFirestore(firebaseApp, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});

setPersistence(auth, browserLocalPersistence).catch(() => {});

export {
    EmailAuthProvider,
    GoogleAuthProvider,
    OAuthProvider,
    GithubAuthProvider,
    TwitterAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    fetchSignInMethodsForEmail,
    signInAnonymously,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut,
    updateProfile,
    updatePassword,
    deleteUser,
    reauthenticateWithPopup,
    reauthenticateWithCredential,
    linkWithPopup,
    linkWithCredential,
    unlink,
    onAuthStateChanged,
    collection,
    doc,
    addDoc,
    setDoc,
    getDocs,
    getDoc,
    onSnapshot,
    writeBatch,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    query,
    orderBy,
    where,
    limit,
    storageRef,
    uploadBytes,
    getDownloadURL,
    deleteObject
};
