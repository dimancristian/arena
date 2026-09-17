# Arena Matematica / Math Arena – RO + EN

Versiunea aceasta are suport bilingv complet pentru banca standard de întrebări.

## Ce a fost adăugat

- comutator `🇷🇴 RO / 🇬🇧 EN` pe ecranul principal;
- limba selectată de gazdă este salvată în setările camerei Socket.IO;
- jucătorii care intră într-o cameră preiau automat limba camerei;
- interfața principală, lobby-ul, feedback-ul, clasamentul și ecranul final au texte RO/EN;
- toate exercițiile matematice builtin funcționează offline în engleză: expresiile numerice rămân identice, iar categoriile sunt traduse (`Addition`, `Subtraction`, `Multiplication`, `Division`, `Missing number`);
- toate cele **335 de variante distincte de cultură generală** au traduceri EN statice în `data/questions.en.json`;
- pentru fiecare întrebare generală sunt traduse static categoria, textul întrebării, toate cele 4 variante de răspuns și descrierea imaginii;
- variantele afișate în engleză sunt asociate cu valorile originale RO, astfel încât validarea răspunsului pe server rămâne neschimbată și sigură;
- întrebările care au același text, dar alt răspuns/imagine (de exemplu ceas 3:00/6:30 sau triunghi/dreptunghi), sunt tratate ca variante distincte;
- Browser Translator API nu mai este necesar pentru nicio întrebare builtin.

## Întrebări personalizate

Întrebările noi adăugate ulterior din panoul profesorului sunt păstrate în `data/questions.json`. Pentru acestea rămâne disponibil fallback-ul Browser Translator API în modul EN, dacă browserul îl suportă.

Dacă vrei ca și întrebările personalizate să fie 100% statice, ele pot primi ulterior câmpuri RO/EN direct în panoul de administrare.
