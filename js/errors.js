import { showToast } from "./ui.js";

export function isBlockedByClient(err) {
    const msg = (err && (err.message || err.code) || "").toString().toLowerCase();
    return msg.includes("blocked") || msg.includes("network") || msg.includes("unavailable") || msg.includes("failed to fetch");
}

export function extractErrorCode(err) {
    const code = String(err?.code || "").trim();
    if (!code) return "unknown";
    return code.includes("/") ? code.split("/").pop() : code;
}

export function getFriendlyErrorDetails(err, context = "opération") {
    const code = extractErrorCode(err);
    const detailsByCode = {
        "permission-denied": {
            userMessage: "Accès refusé pour enregistrer ce bingo.",
            cause: "Les règles Firestore bloquent cette écriture.",
            action: "Vérifie les règles Firestore pour users/{uid}/bingos et que tu es bien connecté au bon compte."
        },
        "unauthenticated": {
            userMessage: "Vous devez être connecté pour enregistrer.",
            cause: "Session Firebase absente ou expirée.",
            action: "Reconnecte-toi puis réessaie."
        },
        unavailable: {
            userMessage: "Service temporairement indisponible.",
            cause: "Firestore n'est pas joignable pour le moment.",
            action: "Réessaie dans quelques secondes."
        },
        "network-request-failed": {
            userMessage: "Échec réseau pendant l'enregistrement.",
            cause: "Connexion interrompue ou requête bloquée.",
            action: "Vérifie la connexion et désactive un éventuel bloqueur pour ce site."
        },
        blocked: {
            userMessage: "Requête bloquée par le navigateur ou une extension.",
            cause: "Un bloqueur empêche l'appel Firestore.",
            action: "Autorise ce site dans le bloqueur puis recharge la page."
        },
        "failed-precondition": {
            userMessage: "Précondition Firestore non satisfaite.",
            cause: "Index manquant ou configuration incomplète.",
            action: "Ouvre la console Firebase pour créer l'index proposé si nécessaire."
        },
        "resource-exhausted": {
            userMessage: "Quota Firestore atteint.",
            cause: "Limite de lecture/écriture dépassée.",
            action: "Attends le reset du quota ou augmente le plan."
        }
    };

    const fallback = {
        userMessage: `Erreur pendant ${context}.`,
        cause: err?.message || "Cause non précisée.",
        action: "Consulte la console pour le détail technique."
    };

    const mapped = detailsByCode[code] || (isBlockedByClient(err) ? detailsByCode.blocked : null) || fallback;
    return {
        code,
        ...mapped,
        rawMessage: String(err?.message || "")
    };
}

export function logStyledError(context, err, details, extra = {}) {
    const titleStyle = "background:#CC0000;color:#fff;padding:3px 8px;border-radius:6px;font-weight:900;";
    const keyStyle = "color:#790000;font-weight:800;";
    const valueStyle = "color:#111;";

    console.groupCollapsed(`%cBINGO ERREUR%c ${context}`, titleStyle, "color:#111;font-weight:800;");
    console.log("%cContexte:%c", keyStyle, valueStyle, context);
    console.log("%cCode:%c", keyStyle, valueStyle, details.code || "unknown");
    console.log("%cCause:%c", keyStyle, valueStyle, details.cause || "-");
    console.log("%cAction conseillée:%c", keyStyle, valueStyle, details.action || "-");
    if (details.rawMessage) {
        console.log("%cMessage brut:%c", keyStyle, valueStyle, details.rawMessage);
    }
    if (Object.keys(extra).length) {
        console.log("%cDonnées utiles:%c", keyStyle, valueStyle, extra);
    }
    console.error(err);
    console.groupEnd();
}

export function getAuthErrorDetails(err, context = "la connexion", providerLabel = null) {
    const code = extractErrorCode(err);
    const isEmailPasswordProvider = providerLabel === "email/password" || providerLabel === "password";
    const detailsByCode = {
        "invalid-credential": {
            userMessage: "Identifiants invalides.",
            cause: isEmailPasswordProvider
                ? "L'adresse e-mail n'est pas liée au mot de passe ou le mot de passe est incorrect."
                : providerLabel
                ? `Le fournisseur ${providerLabel} a refusé l'authentification ou n'a pas renvoyé de session valide.`
                : "Le fournisseur d'authentification a refusé l'identifiant ou le jeton reçu.",
            action: isEmailPasswordProvider
                ? "Si cette adresse est liée à Google/GitHub/X, connecte-toi avec ce fournisseur puis ajoute un mot de passe dans la page Compte."
                : "Vérifie le fournisseur activé, les domaines autorisés et le callback OAuth configuré dans X/Firebase."
        },
        "wrong-password": {
            userMessage: "Mot de passe incorrect.",
            cause: "Le mot de passe saisi ne correspond pas au compte Firebase.",
            action: "Réessaie avec le bon mot de passe ou utilise la réinitialisation."
        },
        "user-not-found": {
            userMessage: "Aucun compte ne correspond à cette adresse.",
            cause: "L'adresse e-mail n'existe pas dans Firebase Auth.",
            action: "Vérifie l'adresse saisie ou crée un compte."
        },
        "operation-not-allowed": {
            userMessage: "Cette méthode de connexion n'est pas activée.",
            cause: "Le fournisseur OAuth ou la connexion e-mail n'est pas autorisé dans Firebase Auth.",
            action: "Active la méthode correspondante dans Firebase Console > Authentication > Sign-in method."
        },
        "unauthorized-domain": {
            userMessage: "Domaine non autorisé.",
            cause: "Le domaine courant n'est pas listé dans les domaines autorisés Firebase.",
            action: "Ajoute le domaine du site dans Firebase Console > Authentication > Settings > Authorized domains."
        },
        "account-exists-with-different-credential": {
            userMessage: "Compte déjà lié à une autre méthode.",
            cause: "Firebase a trouvé un autre fournisseur déjà associé à cette adresse.",
            action: "Connecte-toi avec l'autre méthode puis associe le fournisseur voulu."
        },
        "email-already-in-use": {
            userMessage: "Adresse déjà utilisée.",
            cause: "Un compte existe déjà avec cette adresse e-mail.",
            action: "Connecte-toi avec une méthode existante ou utilise « Mot de passe oublié ? » si le compte a un mot de passe."
        },
        "provider-already-linked": {
            userMessage: "Ce fournisseur est déjà lié.",
            cause: "Le compte est déjà connecté à cette méthode d'authentification.",
            action: "Aucune action requise."
        },
        "credential-already-in-use": {
            userMessage: "Identifiants déjà utilisés.",
            cause: "Ces identifiants sont déjà liés à un autre compte Firebase.",
            action: "Connecte-toi à ce compte existant puis fusionne les données si nécessaire."
        },
        "requires-recent-login": {
            userMessage: "Reconnectez-vous pour continuer.",
            cause: "Cette action sensible nécessite une authentification récente.",
            action: "Reconnecte-toi puis réessaie."
        },
        "weak-password": {
            userMessage: "Mot de passe trop faible.",
            cause: "Le mot de passe ne respecte pas la longueur minimale.",
            action: "Utilise un mot de passe plus long (au moins 6 caractères)."
        },
        "popup-blocked": {
            userMessage: "Fenêtre de connexion bloquée.",
            cause: "Le navigateur ou une extension a bloqué la popup OAuth.",
            action: "Autorise les popups pour ce site puis réessaie."
        },
        "popup-closed-by-user": {
            userMessage: null,
            cause: "La popup a été fermée avant la validation.",
            action: "Relance simplement la connexion."
        }
    };

    const fallback = {
        userMessage: `Erreur pendant ${context}.`,
        cause: err?.message || "Cause non précisée.",
        action: "Consulte la console pour le détail technique."
    };

    const mapped = detailsByCode[code] || fallback;
    return {
        code,
        providerLabel,
        ...mapped,
        rawMessage: String(err?.message || "")
    };
}

export function logAuthError(context, err, providerLabel = null, extra = {}) {
    const details = getAuthErrorDetails(err, context, providerLabel);
    const toastMessage = typeof extra?.toastMessage === "string"
        ? extra.toastMessage
        : details.userMessage;
    const detailsExtra = { ...extra };
    delete detailsExtra.toastMessage;

    if (toastMessage) {
        showToast(`${toastMessage} Voir la console (F12).`, "error");
    }
    logStyledError("Authentification", err, details, {
        provider: providerLabel || "unknown",
        ...detailsExtra
    });
}

export function handleFirestoreError(err) {
    const details = getFriendlyErrorDetails(err, "l'accès aux données");
    if (isBlockedByClient(err)) {
        showToast("Accès à Firestore bloqué (bloqueur de pubs ?). Désactivez-le pour ce site.", "error");
    } else {
        showToast(`${details.userMessage} Voir la console (F12).`, "error");
    }
    logStyledError("Firestore", err, details);
}
