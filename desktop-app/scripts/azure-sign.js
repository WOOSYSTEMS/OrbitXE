const { execSync } = require('child_process');

// Azure Trusted Signing configuration for OrbitXE
const CONFIG = {
  endpoint: 'https://eus.codesigning.azure.net',
  account: 'orbitxe',
  certProfile: 'orbitxe-signing',
  tenantId: 'ba14e2de-4ced-4baf-aa2b-c78d53a57ea2',
  clientId: 'cf00dd85-f5fa-417c-90a2-964c523a4927'
  // Client secret should be set via AZURE_CLIENT_SECRET environment variable
};

exports.default = async function(configuration) {
  const filePath = configuration.path;

  // Skip if not an exe file
  if (!filePath.endsWith('.exe')) {
    return;
  }

  console.log(`Signing ${filePath} with Azure Trusted Signing...`);

  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientSecret) {
    console.log('AZURE_CLIENT_SECRET not set, skipping signing');
    console.log('Set it with: export AZURE_CLIENT_SECRET="your-secret"');
    return;
  }

  try {
    // Using AzureSignTool with Trusted Signing (long-form flags)
    const command = [
      'AzureSignTool sign',
      `--azure-key-vault-tenant-id "${CONFIG.tenantId}"`,
      `--azure-key-vault-client-id "${CONFIG.clientId}"`,
      `--azure-key-vault-client-secret "${clientSecret}"`,
      `--trusted-signing-endpoint "${CONFIG.endpoint}"`,
      `--trusted-signing-account "${CONFIG.account}"`,
      `--trusted-signing-certificate-profile "${CONFIG.certProfile}"`,
      '--timestamp-rfc3161 http://timestamp.digicert.com',
      '--timestamp-digest sha256',
      `"${filePath}"`
    ].join(' ');

    execSync(command, { stdio: 'inherit' });
    console.log(`Successfully signed ${filePath}`);
  } catch (error) {
    console.error('Signing failed:', error.message);
    throw error;
  }
};
