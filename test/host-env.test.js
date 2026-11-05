'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dropAppImagePaths, runsAsAppImage } = require('../src/core/hostEnv');

/* Linux AppImage: programs the app starts get the computer's own paths, not the AppImage's. */

test('the AppImage\'s own folders leave PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const env = {
    APPIMAGE: '/home/v/Apps/EMM.AppImage', APPDIR: '/tmp/.mount_EMMab12',
    PATH: '/tmp/.mount_EMMab12:/tmp/.mount_EMMab12/usr/sbin:/usr/local/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_EMMab12/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_EMMab12/usr/share/:/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/',
    GSETTINGS_SCHEMA_DIR: '/tmp/.mount_EMMab12/usr/share/glib-2.0/schemas:/etc/schemas',
    HOME: '/home/v',
  };
  dropAppImagePaths(env, '/tmp/.mount_EMMab12/edgerunners-mod-manager');
  assert.strictEqual(env.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.ok(!('LD_LIBRARY_PATH' in env), 'nothing of its own: gone, not empty');
  assert.strictEqual(env.XDG_DATA_DIRS, '/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/');
  assert.strictEqual(env.GSETTINGS_SCHEMA_DIR, '/etc/schemas');
  assert.strictEqual(env.HOME, '/home/v');
});

test('a folder that only starts like the AppImage\'s stays; nothing changes outside an AppImage', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const env = { APPIMAGE: '/a.AppImage', APPDIR: '/tmp/.mount_X', PATH: '/tmp/.mount_X:/tmp/.mount_Xother/bin:/usr/bin', LD_LIBRARY_PATH: '/opt/lib' };
  dropAppImagePaths(env, '/tmp/.mount_X/edgerunners-mod-manager');
  assert.strictEqual(env.PATH, '/tmp/.mount_Xother/bin:/usr/bin');
  assert.strictEqual(env.LD_LIBRARY_PATH, '/opt/lib', 'the user\'s own library path is kept');
  const plain = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/x', APPDIR: '/x' }; // APPDIR alone (no APPIMAGE): not one
  dropAppImagePaths(plain, '/x/app');
  assert.deepStrictEqual(plain, { PATH: '/usr/bin', LD_LIBRARY_PATH: '/x', APPDIR: '/x' });
});

test('a copy installed otherwise (the .deb) but started from another AppImage is not an AppImage', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const inherited = { APPIMAGE: '/home/v/Apps/Terminal.AppImage', APPDIR: '/tmp/.mount_Termab', PATH: '/tmp/.mount_Termab:/usr/bin' };
  assert.strictEqual(runsAsAppImage(inherited, '/opt/Cyber Mod Manager/edgerunners-mod-manager'), false, 'so its updater never replaces that AppImage');
  assert.strictEqual(runsAsAppImage(inherited, '/tmp/.mount_Termab/terminal'), true);
  assert.strictEqual(runsAsAppImage({ APPIMAGE: '/a', APPDIR: 'relative' }, '/relative/x'), false);
  dropAppImagePaths(inherited, '/opt/Cyber Mod Manager/edgerunners-mod-manager');
  assert.strictEqual(inherited.PATH, '/tmp/.mount_Termab:/usr/bin', 'nothing changed');
});
