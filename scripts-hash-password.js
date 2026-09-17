const bcrypt = require('bcrypt');

const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Folosește: npm run hash-password -- "o-parola-de-cel-putin-12-caractere"');
  process.exit(1);
}

bcrypt.hash(password, 12)
  .then(hash => console.log(hash))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
