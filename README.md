# Packshot Studio

Batch background-removal + studio-shadow tool. Deploys to Netlify with one
serverless function.

## Files (do not move or rename)
- index.html                  the app
- netlify.toml                routing config
- netlify/functions/api.js    the backend function
- sample.csv                  example CSV for Mode 4

## Deploy (GitHub + Netlify)
1. Create a new GitHub repository.
2. Upload the WHOLE contents of this folder, keeping the netlify/functions
   folder nested exactly as it is.
3. In Netlify: Add new site -> Import an existing project -> pick the repo.
   Build command: leave EMPTY. Publish directory: . (a single dot)
4. In the site's Environment variables, add:
     FAL_API_KEY      = your Fal key
     OPENAI_API_KEY   = your OpenAI key   (optional, only for SKU auto-detect)
5. Deploy. Then open the site and click "Health Check".

## Test the function is live
Visit:  https://YOUR-SITE.netlify.app/.netlify/functions/api
You should see: {"error":"Method not allowed"}  (this is correct)

## CSV mode (Mode 4)
Upload a CSV with two columns: sku and link. Each image is processed and
renamed using the SKU from your file. See sample.csv.
