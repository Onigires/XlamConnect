const ru = {
  appTag: 'Виртуальная сеть для игр и друзей',
  networks: 'Сети', noNetworks: 'Пока нет сохранённых сетей', create: 'Создать сеть', join: 'Войти в сеть', settings: 'Настройки',
  connect: 'Подключиться', disconnect: 'Отключиться', connecting: 'Подключаемся…', reconnecting: 'Переподключаемся…', offline: 'Не подключено', online: 'В сети',
  you: 'Вы', peersOnline: (n) => `${n} ${plural(n, 'участник', 'участника', 'участников')} онлайн`, aloneTitle: 'Здесь пока только вы',
  aloneText: 'Отправьте друзьям название сети, пароль и адрес сервера — они появятся здесь, как только зайдут.', copyInvite: 'Скопировать приглашение',
  yourIp: 'Ваш IP в сети', publicEp: 'Внешний адрес', serverPing: 'Пинг до сервера', tx: 'Отправлено', rx: 'Получено',
  colName: 'Игрок', colIp: 'Виртуальный IP', colPath: 'Канал', colPing: 'Пинг', colTraffic: 'Трафик',
  direct: 'Напрямую', relay: 'Через сервер', link: 'Соединение…',
  directHint: 'Прямое P2P-соединение — минимальная задержка', relayHint: 'Прямой путь не пробился (строгий NAT), трафик идёт через сервер', linkHint: 'Пробиваем NAT…',
  copied: 'Скопировано', copy: 'Копировать',
  createTitle: 'Создать сеть', joinTitle: 'Войти в сеть', createSub: 'Придумайте название и пароль — друзья войдут по ним.', joinSub: 'Введите название сети и пароль от владельца.',
  netName: 'Название сети', password: 'Пароль', server: 'Адрес сервера', serverHint: 'host:порт — например vpn.example.com:7777', remember: 'Запомнить сеть', cancel: 'Отмена',
  welcomeTitle: 'Играйте как в одной локалке', welcomeText: 'Xlam Connect объединяет компьютеры в приватную виртуальную сеть: прямые P2P-соединения, сквозное шифрование и свои IP-адреса — игры по «LAN», общие папки, удалённый доступ.',
  step1: 'Создайте сеть', step1d: 'Название + пароль', step2: 'Отправьте друзьям', step2d: 'Название, пароль, адрес сервера', step3: 'Играйте', step3d: 'Подключайтесь по виртуальным IP',
  needAdmin: 'Нужны права администратора', needAdminText: 'Для создания виртуального адаптера запустите Xlam Connect от имени администратора.',
  noServer: 'Не указан сервер', noServerText: 'Для работы нужен сервер координации (папка server/ в проекте). Укажите его адрес при создании сети.',
  chat: 'Чат', chatPlaceholder: 'Сообщение…', chatEmpty: 'Сообщения видны только участникам сети и шифруются.', chatOffline: 'Подключитесь к сети, чтобы писать',
  nick: 'Ваш ник', language: 'Язык', autoConnect: 'Подключаться к последней сети при запуске', closeToTray: 'Сворачивать в трей при закрытии, пока есть подключение', firewall: 'Разрешить входящие от участников сети', firewallHint: 'Правило брандмауэра только для адаптера Xlam — нужно для ping, игр и общих папок',
  save: 'Сохранить', saved: 'Сохранено', diagnostics: 'Диагностика', admin: 'Права администратора', yes: 'Да', no: 'Нет', adapter: 'Транспорт', encrypted: 'Сквозное шифрование', about: 'О программе',
  settingsNote: 'Ник и адаптер применятся при следующем подключении.', forget: 'Удалить сеть', forgetQ: (n) => `Удалить «${n}» из списка?`,
  errors: { badauth: 'Неверный пароль', exists: 'Сеть с таким названием уже существует', notfound: 'Сеть не найдена — проверьте название или создайте её', conn: 'Не удалось связаться с сервером', timeout: 'Сервер не отвечает', dns: 'Не удалось найти адрес сервера', full: 'Сеть заполнена', badname: 'Название должно быть от 3 до 32 символов', tun: 'Не удалось создать виртуальный адаптер', noserver: 'Укажите адрес сервера', admin: 'Нужны права администратора', version: 'Версия клиента не подходит серверу' },
};
const en = {
  appTag: 'Virtual LAN for games and friends',
  networks: 'Networks', noNetworks: 'No saved networks yet', create: 'Create network', join: 'Join network', settings: 'Settings',
  connect: 'Connect', disconnect: 'Disconnect', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline', online: 'Online',
  you: 'You', peersOnline: (n) => `${n} ${n === 1 ? 'peer' : 'peers'} online`, aloneTitle: "It's just you here",
  aloneText: 'Send your friends the network name, password and server address — they will appear here as soon as they join.', copyInvite: 'Copy invite',
  yourIp: 'Your network IP', publicEp: 'Public address', serverPing: 'Server ping', tx: 'Sent', rx: 'Received',
  colName: 'Player', colIp: 'Virtual IP', colPath: 'Path', colPing: 'Ping', colTraffic: 'Traffic',
  direct: 'Direct', relay: 'Relayed', link: 'Linking…',
  directHint: 'Direct P2P connection — lowest latency', relayHint: 'Direct path failed (strict NAT), traffic goes through the server', linkHint: 'Punching through NAT…',
  copied: 'Copied', copy: 'Copy',
  createTitle: 'Create network', joinTitle: 'Join network', createSub: 'Pick a name and a password — friends join with them.', joinSub: 'Enter the network name and the password from its owner.',
  netName: 'Network name', password: 'Password', server: 'Server address', serverHint: 'host:port — e.g. vpn.example.com:7777', remember: 'Remember this network', cancel: 'Cancel',
  welcomeTitle: 'Play like you are on one LAN', welcomeText: 'Xlam Connect links computers into a private virtual network: direct P2P links, end-to-end encryption and their own IP addresses — LAN games, shared folders, remote access.',
  step1: 'Create a network', step1d: 'Name + password', step2: 'Invite friends', step2d: 'Name, password, server address', step3: 'Play', step3d: 'Connect via virtual IPs',
  needAdmin: 'Administrator rights required', needAdminText: 'Run Xlam Connect as administrator to create the virtual adapter.',
  noServer: 'No server configured', noServerText: 'A coordination server (the server/ folder) is required. Enter its address when creating a network.',
  chat: 'Chat', chatPlaceholder: 'Message…', chatEmpty: 'Messages are visible only to network members and are encrypted.', chatOffline: 'Connect to a network to chat',
  nick: 'Your nickname', language: 'Language', autoConnect: 'Connect to the last network on startup', closeToTray: 'Minimize to tray on close while connected', firewall: 'Allow inbound from network members', firewallHint: 'Firewall rule bound to the Xlam adapter only — needed for ping, games and shared folders',
  save: 'Save', saved: 'Saved', diagnostics: 'Diagnostics', admin: 'Administrator rights', yes: 'Yes', no: 'No', adapter: 'Transport', encrypted: 'End-to-end encrypted', about: 'About',
  settingsNote: 'Nickname and adapter changes apply on next connect.', forget: 'Remove network', forgetQ: (n) => `Remove "${n}" from the list?`,
  errors: { badauth: 'Wrong password', exists: 'A network with this name already exists', notfound: 'Network not found — check the name or create it', conn: "Can't reach the server", timeout: 'Server is not responding', dns: "Can't resolve the server address", full: 'Network is full', badname: 'Name must be 3-32 characters', tun: "Couldn't create the virtual adapter", noserver: 'Enter the server address', admin: 'Administrator rights required', version: 'Client version is not supported by the server' },
};
function plural(n, a, b, c) { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; }
let cur = ru;
export const setLang = (l) => { cur = l === 'en' ? en : ru; document.documentElement.lang = l === 'en' ? 'en' : 'ru'; };
export const detectLang = (c) => c || ((navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en');
export const t = (k, ...a) => { const v = cur[k]; return typeof v === 'function' ? v(...a) : v ?? k; };
export const errText = (code, fallback) => cur.errors[code] || fallback || code;
