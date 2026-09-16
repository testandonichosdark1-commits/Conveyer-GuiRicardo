# Guide complet — Faceless Video Generator

> Un guide pas-à-pas pour **débutants**. Aucune compétence technique requise.
> Vous collez un script, l'app fabrique une vidéo YouTube complète : une voix
> (ElevenLabs), un présentateur-avatar récurrent (HeyGen) qui apparaît de temps
> en temps, et des images/vidéos réelles ou générées par IA pour illustrer le
> propos. Tout tourne **sur votre ordinateur**. (English version: [GUIDE-EN.md](./GUIDE-EN.md).)
>
> 💡 L'interface est bilingue : utilisez le bouton **FR / EN** (en haut à droite).

---

## 1. Comment ça marche (en 30 secondes)

```
Votre script (texte)
      │
      ▼
1) ElevenLabs lit le script à voix haute  →  la voix de la vidéo
      │
      ▼
2) L'app découpe la narration en petits "moments" (selon le rythme de la voix)
      │
      ▼
3) Pour chaque moment :
      • parfois → l'AVATAR parle à l'écran (HeyGen)
      • le reste → une image/vidéo qui illustre la phrase
                   (footage réel d'internet  OU  image IA — votre choix)
                   les photos fixes reçoivent un léger zoom (effet "Ken Burns")
      │
      ▼
4) Tout est assemblé en une seule vidéo MP4, prête pour YouTube
```

Vous gardez le contrôle : combien l'avatar apparaît, réel vs IA, durée de chaque
image, le style, etc.

---

## 2. Ce qu'il vous faut

### Un ordinateur
- **Mac** ou **Windows** (10/11). Rien d'autre à acheter.

### Deux logiciels gratuits (installés une seule fois)
1. **Node.js** (version 20 ou plus) — le moteur de l'app.
   Téléchargez le bouton « LTS » sur **https://nodejs.org/** et installez (Suivant → Suivant).
2. **FFmpeg** — assemble la vidéo.
   - **Mac** : ouvrez l'app « Terminal » et tapez : `brew install ffmpeg`
     (si `brew` n'existe pas, installez d'abord Homebrew depuis **https://brew.sh/**).
   - **Windows** : téléchargez « ffmpeg » sur **https://www.gyan.dev/ffmpeg/builds/**
     (fichier « ffmpeg-release-essentials.zip »), décompressez-le, et soit ajoutez
     le dossier `bin` au PATH, soit indiquez le chemin du fichier `ffmpeg.exe` dans
     l'app (voir §9 « FFmpeg introuvable »).

### Des clés API (les « mots de passe » des services)
Vous les copiez **une seule fois** dans l'app (page **Paramètres**). Indispensables :

| Service | À quoi ça sert | Où l'obtenir |
|---|---|---|
| **HeyGen** | crée l'avatar + l'anime | https://app.heygen.com/settings/api |
| **ElevenLabs** | la voix qui lit le script | https://elevenlabs.io → Profil → API Keys |
| **kie.ai** | images/vidéos IA (nano-banana, Veo) | https://kie.ai/api-key |

Optionnelles (recommandées) :

| Service | À quoi ça sert | Où l'obtenir |
|---|---|---|
| **Google Gemini** | choisit mieux quoi montrer à l'écran | https://aistudio.google.com/app/apikey (gratuit) |
| **Pexels** | footage/photos réels gratuits | https://www.pexels.com/api/ |
| **Pixabay** | footage/photos réels gratuits | https://pixabay.com/api/docs/ |

> 💡 Vous n'êtes pas obligé d'avoir TOUTES les clés. Minimum pour commencer :
> **HeyGen + ElevenLabs** (avatar + voix) et **kie.ai** (visuels IA). Ajoutez
> Pexels/Pixabay quand vous voulez du vrai footage.

---

## 3. Installation (une seule fois)

1. **Récupérez le projet** :
   - Le plus simple : sur la page GitHub, bouton vert **« Code » → « Download ZIP »**,
     puis décompressez le dossier où vous voulez (ex. Documents).
   - (Avancé : `git clone https://github.com/Bander4ik/Conveyer-Patrice.git`)
2. **Installez les dépendances** (une fois) :
   - **Mac** : double-cliquez **`install.command`** dans le dossier.
     *(Si macOS bloque : clic droit → Ouvrir → Ouvrir.)*
   - **Windows** : double-cliquez **`install.bat`**.
   - Une fenêtre noire s'ouvre, ça télécharge ~1-2 min, puis « Done! ».

C'est tout pour l'installation.

---

## 4. Lancer l'app (à chaque utilisation)

- **Mac** : double-cliquez **`start.command`**.
- **Windows** : double-cliquez **`start.bat`**.

Une fenêtre noire reste ouverte (c'est normal — c'est le « moteur », ne la fermez
pas tant que vous travaillez), et votre navigateur ouvre **http://localhost:3000**.

Pour **arrêter** : fermez cette fenêtre noire (ou `stop.bat` / `stop.command`).

---

## 5. Configuration des clés (page **Paramètres**)

En haut à droite, cliquez **Paramètres**. Collez vos clés :

1. **ElevenLabs — API key** : collez la clé.
2. **ElevenLabs — voice_id** : c'est la VOIX. Cliquez **« Charger les voix »**,
   puis choisissez une voix dans la liste (elle remplit le champ automatiquement).
3. **kie.ai — API key** : collez la clé.
4. **HeyGen — API key** : collez la clé.
5. **HeyGen — voice_id** : laissez tel quel (la voix vient d'ElevenLabs ; ce champ
   n'est utilisé que si vous faites parler l'avatar directement sans ElevenLabs).
6. **Pexels / Pixabay** (optionnel) : collez si vous en avez.
7. Bloc **Avancé** : **Provider IA** = `kie.ai` (par défaut) ; **Média IA** =
   `Images` (économique) ou `Vidéo (Veo)` (plus réaliste, voir §8).
8. Cliquez **Enregistrer**.

> 🔒 Les clés restent **sur votre ordinateur** (base locale). Une clé déjà
> enregistrée s'affiche masquée (•••) — si vous n'y touchez pas, elle ne change pas.

---

## 6. Créer un avatar (page **Avatars**)

L'avatar est votre présentateur récurrent — créé une fois, réutilisable partout.

1. **Nom** : ex. « Narrateur Alex ».
2. **Chaîne (optionnel)** : laissez « Toutes » pour le rendre dispo partout.
3. Choisissez **UNE** des deux options :
   - **Image de référence** : cliquez « Choisir le fichier » et envoyez une photo
     nette, de face, bien éclairée. **OU**
   - **Description textuelle** : décrivez la personne en anglais
     (ex. *« a friendly man in his 30s, short brown hair, blue shirt »*) — l'app
     génère l'image via nano-banana.
4. (Option) **Moteur Avatar IV** coché = rendu plus réaliste (consomme plus de crédits).
5. **Créer l'avatar**.

L'avatar apparaît dans la grille avec un statut :
- **Préparation… / Entraînement…** : patientez (quelques secondes à quelques minutes).
- **Prêt** ✅ : utilisable dans une vidéo.
- **Erreur** : voir le message (souvent : clé HeyGen manquante / photo refusée).

---

## 7. Créer une chaîne (page **Chaînes**) — optionnel mais pratique

Une **chaîne** = un jeu de réglages par défaut, pour ne pas tout re-régler à
chaque vidéo. Champs :

- **Nom** : ex. « Histoire ».
- **Mode visuel** : `Mix` (réel + IA), `Vrai footage` (réel uniquement) ou `Images IA`.
- **Style images IA (animation / rendu)** : le style des visuels IA
  (ex. *« cinematic, photo realistic »*). C'est votre **prompt de style / animation**.
- **Intervalle (s)** : combien de temps chaque image/clip reste à l'écran (ex. 4–6 s).
- **Format** : `1920x1080` (YouTube classique) ou `1080x1920` (Shorts vertical).
- **Prompt visuel (découpage / choix des images)** : votre **prompt de
  « découpage »**. Il guide CE QUI est cherché/montré pour chaque phrase de la
  narration. **Laissez vide** pour un comportement par défaut, ou écrivez par ex. :
  *« Documentaire historique. Pour chaque ligne, donne une requête visuelle de
  3–8 mots concrets : lieux, objets, archives réelles. Évite l'abstrait. »*

Cliquez **Créer la chaîne**. Pour modifier plus tard : **Modifier** sur la chaîne.

---

## 8. Créer une vidéo (page **Créer une vidéo**)

1. **Titre (optionnel)** : pour vous y retrouver.
2. **Chaîne** : choisissez-en une (elle pré-remplit mode, style, prompt, intervalle,
   format) — ou « Aucune — réglages manuels ».
3. **Script** : collez tout le texte de la narration.
4. **Avatar** : choisissez un avatar **Prêt**, ou « Aucun » (vidéo sans visage).
5. **Mode visuel** : `Images IA`, `Vrai footage`, ou `Mix`.
6. **Équilibre réel / IA** (en mode Mix) : ex. 80 % réel / 20 % IA.
7. **Intervalle par visuel (s)** : durée de chaque image/clip.
8. **Avatar à l'écran (%)** : à quelle fréquence l'avatar apparaît (ex. 15 % =
   « de temps en temps »). Désactivé si aucun avatar choisi.
9. **Créer la vidéo**.

Vous êtes redirigé vers la page de suivi : les étapes s'affichent en direct
(voix → plans → visuels → assemblage).

---

## 9. Suivre le rendu et récupérer la vidéo (page **Jobs**)

- Chaque vidéo apparaît avec son **statut** (`running`, `done`, `error`) et son **mode**.
- Quand c'est **done** : cliquez **⬇ mp4** pour télécharger, ou **Suivre** pour revoir
  les détails et lire la vidéo.

⏱️ **Combien de temps ?** Selon la longueur du script et le mode. La partie la plus
lente est l'avatar (HeyGen) et la vidéo IA (Veo). Une courte vidéo : quelques
minutes ; une longue avec beaucoup d'avatar : 10–30 min. C'est normal.

---

## 10. Conseils pour un rendu RÉALISTE (important)

Le footage « stock » (Pexels/Pixabay) peut faire trop « banque d'images ». Pour
un rendu authentique comme les bonnes chaînes YouTube :

- **Privilégiez le vrai footage** : mettez l'équilibre vers **80–100 % réel**.
- **Pour la partie IA, utilisez Veo** : Paramètres → Avancé → **Média IA = Vidéo (Veo)**.
  Veo donne des plans bien plus réalistes que de simples images (mais consomme plus).
- **Soignez le « Prompt visuel »** de la chaîne : demandez des images concrètes
  (lieux réels, objets, archives) plutôt que des concepts abstraits.
- **Avatar « de temps en temps »** : 15–25 % suffit pour un présentateur récurrent
  sans lasser.
- **(Avancé) YouTube** : on peut activer une source YouTube (Réglages complets →
  `YT_DLP_ENABLED`), mais ⚠️ le contenu YouTube est protégé par le droit d'auteur —
  à n'utiliser que pour du contenu libre/dont vous avez les droits. Désactivé par défaut.

---

## 11. Combien ça coûte ?

L'app est gratuite ; vous payez seulement les services que vous utilisez :

- **ElevenLabs** : selon le nombre de caractères lus (offre gratuite limitée, puis abonnement).
- **HeyGen** : en crédits, surtout pour l'avatar (Avatar IV ≈ 3 s = 1 crédit ;
  ~4 $/min en 1080p côté API). L'avatar n'est généré que pour les ~15 % de plans
  où il apparaît → coût maîtrisé.
- **kie.ai** : par image/vidéo générée (Veo coûte plus que les images nano-banana).
- **Pexels / Pixabay / Wikimedia / Openverse** : **gratuits**.
- **Google Gemini** : quasi gratuit (petit usage).

> 💡 Pour limiter les coûts : mode **Vrai footage** (gratuit) + avatar à faible %,
> et **Média IA = Images** plutôt que Vidéo.

---

## 12. Dépannage (problèmes courants)

| Symptôme | Solution |
|---|---|
| L'avatar reste sur « Préparation » / « Erreur » | Vérifiez la **clé HeyGen** (Paramètres). Une photo peu nette ou refusée par la modération échoue — réessayez avec une autre photo. |
| « ELEVENLABS… » / pas de voix | Clé ElevenLabs manquante ou **voice_id** vide. Cliquez « Charger les voix » et choisissez-en une. |
| Erreur kie.ai (« code 402 / 401 ») | 402 = plus de crédits sur kie.ai ; 401 = clé invalide. Rechargez/corrigez la clé. |
| « FFmpeg failed » / pas de vidéo finale | FFmpeg n'est pas installé. Mac : `brew install ffmpeg`. Windows : installez-le, ou ouvrez **Réglages complets** (lien en bas de Paramètres) et renseignez **FFMPEG_PATH** avec le chemin de `ffmpeg.exe`. |
| Pas de footage réel trouvé | Ajoutez une clé **Pexels** et/ou **Pixabay** (Paramètres). Sans elles, l'app bascule sur l'IA. |
| La vidéo fait trop « stock » | Voir §10 : plus de réel, Veo pour l'IA, meilleur prompt visuel. |
| La page noire (Terminal/CMD) s'est fermée | C'est le moteur — relancez `start.command` / `start.bat`. |
| Format vertical (Shorts) | Créez une chaîne avec **Format = 1080x1920** et choisissez-la. |

---

## 13. Où sont rangés mes fichiers ?

- **Réglages, avatars, historique** : dans un dossier caché de votre profil
  utilisateur, `~/.faceless-studio` (Mac/Linux) ou `C:\Users\VOUS\.faceless-studio`
  (Windows). Il n'est **jamais** supprimé par une mise à jour de l'app.
- **Vidéos générées** : dans ce même dossier, sous `runs/<nom>/final.mp4`
  (téléchargeables aussi depuis la page **Jobs**).

---

## Récapitulatif express

1. Installer **Node.js** + **FFmpeg** (une fois).
2. `install.command` / `install.bat`, puis `start.command` / `start.bat`.
3. **Paramètres** → coller HeyGen + ElevenLabs + kie.ai → Enregistrer.
4. **Avatars** → créer un avatar (photo ou description) → attendre « Prêt ».
5. *(option)* **Chaînes** → créer une chaîne avec votre style + prompt visuel.
6. **Créer une vidéo** → coller le script, choisir l'avatar et le mode → **Créer la vidéo**.
7. **Jobs** → télécharger le **mp4**.

Bonnes vidéos ! 🎬
