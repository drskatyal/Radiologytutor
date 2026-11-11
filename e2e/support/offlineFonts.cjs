// Local validation only: Next's documented test hook prevents remote font fetches.
module.exports = new Proxy({}, {
  get: () => "@font-face { font-family: 'Offline validation'; src: local('Arial'); font-weight: 100 900; }",
});
