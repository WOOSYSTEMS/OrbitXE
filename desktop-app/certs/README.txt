WINDOWS CODE SIGNING SETUP
==========================

When you receive your certificate from SSL.com:

1. Download the .pfx file they email you
2. Rename it to: windows-signing.pfx
3. Put it in this folder (desktop-app/certs/)
4. Set the password as an environment variable:

   On Mac/Linux:
   export WIN_CSC_KEY_PASSWORD="your-certificate-password"

   On Windows:
   set WIN_CSC_KEY_PASSWORD=your-certificate-password

5. Build the signed Windows app:
   npm run build:win

The output will be in desktop-app/dist/ folder - fully signed, no security warnings.

IMPORTANT: Never commit the .pfx file to git!
