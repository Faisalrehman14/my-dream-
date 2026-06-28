const Auth = (function () {
  'use strict';

  let ready = false;
  let user = null;

  function getAppId() {
    return FB_CONFIG.appId?.trim() || '';
  }

  function initSDK() {
    const appId = getAppId();
    if (!appId) {
      return Promise.reject(
        new Error(
          'App is not configured yet. Owner must set FACEBOOK_APP_ID on Railway (or js/config.js).'
        )
      );
    }
    if (ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      window.fbAsyncInit = function () {
        try {
          FB.init({
            appId,
            cookie: true,
            xfbml: false,
            version: FB_CONFIG.version,
          });
          ready = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      if (!document.getElementById('facebook-jssdk')) {
        const s = document.createElement('script');
        s.id = 'facebook-jssdk';
        s.src = 'https://connect.facebook.net/en_US/sdk.js';
        s.async = true;
        s.defer = true;
        s.onerror = () => reject(new Error('Could not load Facebook SDK. Check your internet connection.'));
        document.body.appendChild(s);
      } else if (window.FB) {
        window.fbAsyncInit();
      }
    });
  }

  const REQUIRED_SCOPES = [
    'pages_show_list',
    'pages_messaging',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_utility_messaging',
  ];

  function checkSession() {
    return new Promise((resolve) => {
      if (!ready) return resolve(null);
      FB.getLoginStatus((res) => {
        if (res.status !== 'connected') return resolve(null);
        const token = res.authResponse.accessToken;
        const ver = FB_CONFIG.version || 'v21.0';
        const url = `https://graph.facebook.com/${ver}/me/permissions?access_token=${encodeURIComponent(token)}`;
        fetch(url)
          .then((r) => r.json())
          .then((perms) => {
            if (perms.error) return resolve(null);
            const granted = (perms.data || [])
              .filter((p) => p.status === 'granted')
              .map((p) => p.permission);
            const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
            if (missing.length > 0) return resolve(null);
            resolve(res.authResponse);
          })
          .catch(() => resolve(null));
      });
    });
  }

  async function verifyGrantedScopes() {
    const perms = await GraphAPI.getPermissionStatus();
    const missing = REQUIRED_SCOPES.filter((s) => !perms.granted.includes(s));
    if (missing.length) {
      throw new Error(
        `Missing permissions: ${missing.join(', ')}. Log in again and tap Allow for every permission (especially pages_read_engagement).`
      );
    }
    return perms;
  }

  function login(options = {}) {
    return new Promise((resolve, reject) => {
      FB.login(
        (res) => {
          if (res.authResponse) {
            res.authResponse.grantedScopes = res.authResponse.grantedScopes || '';
            verifyGrantedScopes()
              .then(() => resolve(res.authResponse))
              .catch(reject);
            return;
          }
          if (res.status === 'not_authorized') {
            reject(
              new Error(
                'Permissions not granted. Please accept all permissions so we can load your Page inbox.'
              )
            );
            return;
          }
          reject(
            new Error(
              'Login cancelled. If you cannot log in, the app may still be in Development mode — ask the app owner to add you as a Tester, or wait until the app is Live.'
            )
          );
        },
        {
          scope: FB_CONFIG.scopes,
          return_scopes: true,
          auth_type: options.reauthorize ? 'reauthorize' : 'rerequest',
        }
      );
    });
  }

  function loginReauthorize() {
    return login({ reauthorize: true });
  }

  function logout() {
    return new Promise((resolve) => {
      if (ready) FB.logout(() => resolve());
      else resolve();
    });
  }

  async function fetchUser() {
    user = await GraphAPI.getMe();
    return user;
  }

  function getUser() {
    return user;
  }

  function isReady() {
    return ready;
  }

  /** Ask Facebook again for all permissions (e.g. after adding pages_read_engagement) */
  function rerequestPermissions() {
    return login({ reauthorize: true });
  }

  return {
    getAppId,
    initSDK,
    checkSession,
    login,
    loginReauthorize,
    rerequestPermissions,
    verifyGrantedScopes,
    logout,
    fetchUser,
    getUser,
    isReady,
  };
})();
