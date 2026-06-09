# Bingo Interactif - Configuration Base de Donnees (Firebase)

Ce projet utilise **Firebase Authentication** (Google) et **Cloud Firestore**.

Important pour un projet open source:
- La config Firebase web (apiKey, authDomain, etc.) n'est **pas un secret** technique cote navigateur.
- La vraie protection se fait avec:
  - les **regles Firestore**,
  - les **domaines autorises** dans Firebase Auth,
  - les **quotas / alertes budget**,
  - optionnellement **App Check**.

## 1. Architecture de donnees

Chemin principal utilise par l'application:
- `users/{uid}/bingos/{bingoId}`

Exemple de document Bingo:

```json
{
  "title": "Nintendo Direct 2026",
  "category": "Nintendo",
  "size": 3,
  "cells": ["Case 1", "Case 2", "Case 3"],
  "markedCells": [false, true, false],
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

Contraintes appliquees dans l'app:
- `size` autorise: `3`, `4`, `5`
- max bingos charges: `50`
- toutes les `cells` sont obligatoires

## 2. Requetes Firestore utilisees

- Liste des bingos (ordre desc):
  - `orderBy("createdAt", "desc")`
  - `limit(50)`
- Filtre categorie:
  - `where("category", "==", <cat>)`
  - `orderBy("createdAt", "desc")`
  - `limit(50)`

## 3. Regles Firestore recommandees

Crée ou remplace les regles Firestore avec ce socle:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() {
      return request.auth != null;
    }

    function isOwner(uid) {
      return isSignedIn() && request.auth.uid == uid;
    }

    match /users/{uid} {
      allow read, write: if false;

      match /bingos/{bingoId} {
        allow read, create, update, delete: if isOwner(uid);
      }
    }
  }
}
```

Ensuite, durcis progressivement (validation de schema, taille max des tableaux, etc.) si necessaire.

## 4. Index Firestore

Selon la region/projet, la requete `where(category) + orderBy(createdAt)` peut demander un index composite.

Index conseille:
- Collection: `users/{uid}/bingos`
- Champs:
  - `category` ascendant
  - `createdAt` descendant

Tu peux aussi laisser Firebase proposer automatiquement le lien de creation d'index au premier echec de requete.

## 5. Configuration locale

Le projet charge la config depuis:
- `js/firebase-config.js`

Fichier exemple:
- `js/firebase-config.example.js`

Etapes locales:
1. Copier `js/firebase-config.example.js` vers `js/firebase-config.js`.
2. Remplir les valeurs de ton projet Firebase.
3. Lancer le site localement.

## 6. Configuration production (GitHub Pages)

Le workflow de deploiement:
- `.github/workflows/deploy-pages.yml`

Il injecte `js/firebase-config.js` depuis les secrets GitHub Actions.

Secrets a definir:
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`

## 7. Auth Google - verification

Dans Firebase Console:
1. Authentication > Sign-in method > Google: active.
2. Authentication > Settings > Authorized domains:
   - ton domaine custom (ex: `bingo-perso.bryan.ovh`)
   - domaine GitHub Pages si utilise
   - localhost en dev

## 8. Securite et cout (important)

Pour limiter les risques de depassement:
1. Garde des regles Firestore strictes par `uid`.
2. Active les alertes budget Google Cloud / Firebase.
3. Surveille l'usage Firestore (lectures/ecritures) dans Firebase Console.
4. Ajoute App Check si tu veux limiter les appels abusifs automatises.

## 9. Pourquoi cette doc en open source

Parce que le code est public:
- tout le monde doit comprendre le schema, les regles et le mode de deploiement,
- la securite doit venir des regles et du controle d'acces, pas de l'obfuscation des cles web.
