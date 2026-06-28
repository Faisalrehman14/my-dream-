/**
 * Production: set App ID in Railway → FACEBOOK_APP_ID (auto via /js/env.js)
 * Or paste your App ID below (replace empty string).
 */
/** Bump when deploying — busts browser cache for JS/CSS */
const PAGECHAT_BUILD = '20260628-21';

/** Meta app + product branding (admin & App Review) */
const APP_BRAND = {
  name: 'Wayfair',
  tagline: 'Facebook Page Messenger Manager',
  contactEmail: 'alirunyonali@gmail.com',
  metaCategory: 'Business',
  /** Meta Data handling — edit if your legal entity differs */
  legalEntity: 'Muhammad Faisal Rehman',
  dataControllerCountry: 'Pakistan',
  processors:
    'Railway Corporation — cloud hosting for our HTTPS web application and Messenger webhook endpoint. Railway may process server logs related to webhook delivery. We do not sell or share Meta Platform Data with other third parties.',
};

function isReviewMode() {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  return q.get('review') === '1' || q.get('meta_review') === '1';
}

const FB_CONFIG = {
  appId: (typeof window !== 'undefined' && window.__PAGECHAT__?.appId) || '',
  build: PAGECHAT_BUILD,
  isReviewMode,
  version: 'v21.0',
  scopes: [
    'public_profile',
    'pages_show_list',
    'pages_messaging',
    'pages_read_engagement',
    'pages_utility_messaging',
    'pages_manage_metadata',
  ].join(','),
  webhookFields: ['messages', 'messaging_postbacks', 'message_echoes'],
  storageKeys: {
    appId: 'pagechat_app_id',
    activePageId: 'pagechat_active_page',
    activeConvId: 'pagechat_active_conv',
    utilityPreviews: 'pagechat_utility_previews',
    utilityTemplates: 'pagechat_utility_templates',
  },
};
