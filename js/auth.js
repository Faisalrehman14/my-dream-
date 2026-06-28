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

  function scopesFromGrantedString(grantedScopes) {
    return String(grantedScopes || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function checkSession() {
    return new Promise((resolve) => {
      if (!ready) return resolve(null);
      FB.getLoginStatus((res) => {
        if (res.status !== 'connected') return resolve(null);
        resolve(res.authResponse);
      });
    });
  }

  async function verifyGrantedScopes(authResponse) {
    let granted = scopesFromGrantedString(authResponse?.grantedScopes);
    if (!granted.length) {
      const perms = await GraphAPI.getPermissionStatus();
      granted = perms.granted;
    }
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length) {
      throw new Error(
        `Missing permissions: ${missing.join(', ')}. Log in again and tap Allow for every permission (especially pages_read_engagement).`
      );
    }
    return { granted };
  }

  function login(options = {}) {
    return new Promise((resolve, reject) => {
      const loginOptions = {
        scope: FB_CONFIG.scopes,
        return_scopes: true,
      };
      if (options.reauthorize) loginOptions.auth_type = 'reauthorize';
      else if (options.rerequest) loginOptions.auth_type = 'rerequest';

      FB.login(
        (res) => {
          if (res.authResponse) {
            verifyGrantedScopes(res.authResponse)
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
        loginOptions
      );
    });
  }

  function loginReauthorize() {
    return login({ reauthorize: true });
  }

  function logout() {
    return new Promise((resolve) => {
      GraphAPI.clearPermissionCache?.();
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
    return login({ rerequest: true });
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
