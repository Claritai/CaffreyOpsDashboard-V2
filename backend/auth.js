const { ConfidentialClientApplication } = require('@azure/msal-node');

let msalClient = null;

function getMsalClient() {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
        clientSecret: process.env.AZURE_CLIENT_SECRET,
      },
    });
  }
  return msalClient;
}

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read.Shared',
  'https://graph.microsoft.com/Mail.ReadWrite.Shared',
  'https://graph.microsoft.com/Mail.Send.Shared',
  'https://graph.microsoft.com/User.Read',
];

async function getAuthCodeUrl(state) {
  return getMsalClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: process.env.AZURE_REDIRECT_URI,
    state,
  });
}

async function acquireTokenByCode(code) {
  return getMsalClient().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: process.env.AZURE_REDIRECT_URI,
  });
}

async function acquireTokenSilent(account) {
  return getMsalClient().acquireTokenSilent({
    account,
    scopes: SCOPES,
  });
}

module.exports = { getAuthCodeUrl, acquireTokenByCode, acquireTokenSilent };
