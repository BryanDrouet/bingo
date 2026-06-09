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
    "cells": [
        "Annonce Metroid",
        "Mario Kart",
        "Zelda 2D",
        "Donkey Kong",
        "Kirby",
        "Fire Emblem",
        "Pokemon",
        "Smash",
        "Nouvelle console"
    ],
    "markedCells": [false, true, false, false, false, false, true, false, false],
    "createdAt": "serverTimestamp",
    "updatedAt": "serverTimestamp"
}
```

Contraintes appliquees dans l'app:
- `size` autorise: `3`, `4`, `5`
- max bingos charges: `50`
- toutes les `cells` sont obligatoires
- longueur max du `title`: `100`
- longueur max de `category`: `50`
- longueur max par cellule cote front: `80`

## 2. Requetes Firestore utilisees

- Liste des bingos (ordre desc):
    - `orderBy("createdAt", "desc")`
    - `limit(50)`
- Filtre categorie:
    - `where("category", "==", <cat>)`
    - `orderBy("createdAt", "desc")`
    - `limit(50)`

## 3. Regles Firestore recommandees

Version recommandee pour suivre le comportement actuel du front:

```txt
rules_version = '2';
service cloud.firestore {
    match /databases/{database}/documents {

        function isOwner(uid) {
            return request.auth != null && request.auth.uid == uid;
        }

        function isValidString(field, max) {
            return field is string && field.size() > 0 && field.size() <= max;
        }

        function isValidSize(s) {
            return s is int && s >= 3 && s <= 5;
        }

        function isValidCellsArray(arr, size) {
            return arr is list && arr.size() == size * size;
        }

        function isValidMarked(arr, size) {
            return arr is list
                && arr.size() == size * size
                && arr.hasOnly([true, false]);
        }

        match /users/{userId}/bingos/{bingoId} {

            allow read: if isOwner(userId);

            allow create: if isOwner(userId)
                && request.resource.data.keys().hasOnly([
                    'title','category','size','cells','markedCells','createdAt','updatedAt'
                ])
                && request.resource.data.keys().hasAll([
                    'title','category','size','cells','createdAt','updatedAt'
                ])
                && isValidString(request.resource.data.title, 100)
                && isValidString(request.resource.data.category, 50)
                && isValidSize(request.resource.data.size)
                && isValidCellsArray(request.resource.data.cells, request.resource.data.size)
                && (
                    !request.resource.data.keys().hasAny(['markedCells'])
                    || isValidMarked(request.resource.data.markedCells, request.resource.data.size)
                )
                && request.resource.data.createdAt == request.time
                && request.resource.data.updatedAt == request.time;

            allow update: if isOwner(userId)
                && request.resource.data.keys().hasOnly([
                    'title','category','size','cells','markedCells','createdAt','updatedAt'
                ])
                && isValidString(request.resource.data.title, 100)
                && isValidString(request.resource.data.category, 50)
                && isValidSize(request.resource.data.size)
                && isValidCellsArray(request.resource.data.cells, request.resource.data.size)
                && request.resource.data.createdAt == resource.data.createdAt
                && request.resource.data.updatedAt == request.time
                && (
                    request.resource.data.markedCells == resource.data.markedCells
                    || isValidMarked(request.resource.data.markedCells, request.resource.data.size)
                );

            allow delete: if isOwner(userId);
        }

        match /{document=**} {
            allow read, write: if false;
        }
    }
}
```

Notes:
- ces regles collent a la structure actuellement utilisee dans `js/app.js`
- elles verrouillent l'acces par proprietaire (`uid`)
- elles empechent les champs imprévus
- elles valident la taille des grilles et la forme des tableaux

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
- `js/firebase-config.local.js` en local (`localhost` / `127.0.0.1`)
- fallback local possible vers `js/firebase-config.js`
- `js/firebase-config.js` en production

Fichier exemple:
- `js/firebase-config.example.js`

Etapes locales:
1. Copier `js/firebase-config.example.js` vers `js/firebase-config.local.js`.
2. Remplir les valeurs de ton projet Firebase.
3. Lancer le site localement.

Important:
- `js/firebase-config.local.js` est ignore par Git.
- `js/firebase-config.js` est un placeholder versionne sans cles, ecrase en production par GitHub Actions.

## 6. Configuration production (GitHub Pages)

Le workflow de deploiement:
- `.github/workflows/deploy-pages.yml`

Le deploiement GitHub Pages:
1. recupere le repo,
2. genere `js/firebase-config.js` depuis les secrets GitHub,
3. publie l'artefact sur GitHub Pages.

Le fichier `js/firebase-config.js` present dans le repo ne contient pas de cles. Il sert uniquement a eviter les 404 et est remplace pendant le deploiement.

Secrets a definir:
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`

Placement recommande:
- `Settings > Environments > github-pages > secrets`

Apres ajout ou modification des secrets:
1. pousser sur `main`, ou
2. lancer manuellement le workflow `Deploy to GitHub Pages`

## 7. Auth Google - verification

Dans Firebase Console:
1. Authentication > Sign-in method > Google: active.
2. Authentication > Settings > Authorized domains:
    - ton domaine custom (ex: `bingo-perso.bryan.ovh`)
    - domaine GitHub Pages si utilise
    - `localhost`
    - `127.0.0.1`

## 8. Securite et cout (important)

Pour limiter les risques de depassement:
1. Garde des regles Firestore strictes par `uid`.
2. Active les alertes budget Google Cloud / Firebase.
3. Surveille l'usage Firestore (lectures/ecritures) dans Firebase Console.
4. Ajoute App Check si tu veux limiter les appels abusifs automatises.
5. Restreins les domaines autorises dans Firebase Auth.
6. Surveille la creation d'index Firestore inutiles.

## 9. Pourquoi cette doc en open source

Parce que le code est public:
- tout le monde doit comprendre le schema, les regles et le mode de deploiement,
- la securite doit venir des regles et du controle d'acces, pas de l'obfuscation des cles web.

## 10. Verification rapide

Checklist pour verifier que tout est bien cable:
1. En local, `js/firebase-config.local.js` existe et contient les 6 champs Firebase.
2. En production, les 6 secrets GitHub existent dans l'environnement `github-pages`.
3. Le workflow `Deploy to GitHub Pages` passe en vert.
4. Firebase Auth autorise ton domaine custom et le dev local.
5. Firestore Rules sont publiees avec la version stricte ci-dessus.
