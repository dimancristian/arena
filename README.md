# Arena Matematică — Dashboard PostgreSQL v1.0

Acest pachet migrează **implementarea** Dashboard-ului de la MySQL la PostgreSQL. Nu copiază datele existente din MySQL.

## Instalare în proiectul existent

1. Fă backup la `server.js`, `package.json` și `package-lock.json`.
2. Înlocuiește `server.js` cu cel din pachet și copiază folderul `arena-dashboard-postgres-v1/` în rădăcina proiectului. **Nu șterge** folderele existente `public/`, `data/` și celelalte fișiere proprii proiectului.
3. Integrează modificările din `package.json` (ori înlocuiește-l, dacă cel actual corespunde exact cu versiunea furnizată). Instalează `pg`: `npm install pg` și elimină `mysql2` **numai dacă nu mai este utilizat în altă parte**: `npm uninstall mysql2`.
4. Render Dashboard -> New -> Postgres: creează o bază de date în aceeași regiune și același cont ca web service-ul Node.js. În baza de date, din Connect copiază **Internal Database URL**.
5. În Render -> serviciul Node.js -> Environment adaugă `DATABASE_URL` cu URL-ul intern. Nu publica secretul în repository. Evită `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` vechi; acest modul nu le citește.
6. Commit la `server.js`, folderul nou, `package.json` și `package-lock.json`. Deploy și verifică logul: `Dashboard administrator PostgreSQL inițializat.`
7. Autentifică-te prin `/admin`, apoi intră la `/admin/dashboard`.

Schema PostgreSQL (games, game_players, game_answers) se creează automat la pornire dacă utilizatorul are drepturile necesare.

## Comportament

Partidele noi înregistrează `start -> answer -> complete/abandon` printr-o coadă secvențială per joc; nu se schimbă mecanica Socket.IO. `router.js` rămâne sub `requireAdmin` și folosește sesiunea deja existentă. Dashboard-ul conține doar partidele înregistrate după această schimbare.

## Note importante

- **Nu migrează automat istoricul MySQL**. Dacă baza MySQL conține deja rezultate, exportul și importul lor trebuie făcute separat.
- `express-session` este încă pe MemoryStore în `server.js` original; vei vedea același avertisment pentru sesiuni. Pentru producție e necesar un session store separat, de exemplu PostgreSQL (`connect-pg-simple`), configurat și testat distinct.
- La restart în timpul unei partide, jocul poate rămâne `active` în istoric; acest pachet nu implementează recuperare/reconciliere automată.
- În modelul curent, `players` unici se estimează prin identificatori Socket.IO, nu prin conturi individuale; metrica descrie participări unice pe socket, nu persoane unice persistente.
- Prefixul de rută este `/admin/dashboard`; endpointurile JSON sunt `/admin/dashboard/api/overview`, `/admin/dashboard/api/games`, `/admin/dashboard/api/games/:id`.
- Parolele și URL-urile PostgreSQL sunt secrete. **Rotește parola MySQL expusă anterior**, chiar dacă nu mai folosești acea bază de date.

## Verificare locală

`npm install && npm run check` verifică sintaxa. `npm start` are nevoie de variabilele existente (PayPal și admin pe producție), precum și de `DATABASE_URL` funcțional.
