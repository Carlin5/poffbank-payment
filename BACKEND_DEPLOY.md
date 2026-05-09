# Backend Deployment Guide

The frontend is deployed on Netlify, but the Node.js backend needs to be deployed separately.

## Recommended Backend Hosting Options

### Option 1: Render (Recommended - Free)
1. Go to https://render.com
2. Sign up with GitHub
3. Create New Web Service
4. Connect your GitHub repo
5. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
6. Add Environment Variables:
   ```
   NOWPAYMENTS_API_KEY=BT0AHVQ-MM8M4Z2-H57T2NC-V4EM2QG
   BASE_URL=https://your-service-name.onrender.com
   ```
7. Deploy! (Free tier: spins down after 15min inactivity)

### Option 2: Railway
1. Go to https://railway.app
2. Deploy from GitHub repo
3. Add environment variables in dashboard
4. Deploy (Always-on for $5/month)

### Option 3: Heroku
1. Install Heroku CLI
2. ```bash
   heroku create poffbank-api
   git push heroku main
   ```
3. Add environment variables via dashboard

## After Backend Deployment

Update `script.js` with your backend URL:

```javascript
const CONFIG = {
    apiUrl: window.location.origin.includes('localhost') 
        ? 'http://localhost:3000' 
        : 'https://your-backend-url.com',  // <-- UPDATE THIS
    // ... rest of config
};
```

Then redeploy frontend:
```bash
npx netlify-cli deploy --prod
```

## Current Setup

| Component | URL | Status |
|-----------|-----|--------|
| Frontend (Netlify) | https://carlin5.netlify.app | ✅ Deployed |
| Backend (local) | http://localhost:3000 | Running locally |
| Backend (production) | Not deployed yet | Needs setup |

## Testing Locally

To test with local backend:
```bash
npm start
```
Then visit http://localhost:3000

## Full Production Setup

1. Deploy backend to Render/Railway/Heroku
2. Update `script.js` with backend URL
3. Commit and push to GitHub
4. Redeploy frontend: `npx netlify-cli deploy --prod`
5. Update Netlify redirects in `netlify.toml` to point to your backend
