'use strict';
// 7-Zip for the tests: Windows' usual 7z.exe; on Linux 7zz/7z/7za as the app finds it (PATH).
const { sevenZip } = require('../src/core/manager');

module.exports = process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : sevenZip('') || '/usr/bin/7zz';
