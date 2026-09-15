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
    getDocs,
    getDoc,
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
    const expectedConfigFile = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? "js/firebase-config.local.js (ou fallback local js/firebase-config.js)"
        : "js/firebase-config.js";
    if (app) {
        app.innerHTML = `
            <div class="view view-login">
                <header class="app-header">
                    <div class="header-left">
                        <div class="header-title-group">
                            <span class="header-main-text">Bingo</span>
                        </div>
                    </div>
                </header>
                <div class="login-body">
                    <div class="login-card">
                        <h1>Configuration manquante</h1>
                        <p>La configuration Firebase n'est pas chargee. Verifiez le fichier ${expectedConfigFile}.</p>
                    </div>
                </div>
            </div>
        `;
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
    getDocs,
    getDoc,
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
