// metaAdsSdk.js — Shared Meta Marketing API SDK singleton
// All Meta Ads client code imports from here instead of creating its own access instances
require("dotenv").config({ quiet: true });
const bizSdk = require("facebook-nodejs-business-sdk");

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // e.g. "act_270470901"
const META_BUSINESS_ID = process.env.META_BUSINESS_ID; // e.g. "3385896878322413"

if (!META_ACCESS_TOKEN) {
  console.warn("[Meta SDK] META_ACCESS_TOKEN is not set — SDK will not authenticate.");
}
if (!META_AD_ACCOUNT_ID) {
  console.warn("[Meta SDK] META_AD_ACCOUNT_ID is not set — ad account calls will fail.");
}

const api = bizSdk.FacebookAdsApi.init(META_ACCESS_TOKEN);

const AdAccount = bizSdk.AdAccount;
const Campaign = bizSdk.Campaign;
const AdSet = bizSdk.AdSet;
const Ad = bizSdk.Ad;
const Business = bizSdk.Business;

const adAccount = META_AD_ACCOUNT_ID ? new AdAccount(META_AD_ACCOUNT_ID) : null;

module.exports = {
  api,
  bizSdk,
  AdAccount,
  Campaign,
  AdSet,
  Ad,
  Business,
  adAccount,
  META_AD_ACCOUNT_ID,
  META_BUSINESS_ID,
};
