module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    // Por ahora no hace nada — aquí van a ir funciones de mensajes más adelante.
  },
};
