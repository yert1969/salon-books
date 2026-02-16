# Salon Books — Setup Guide

## What You Have
A complete Progressive Web App (PWA) for tracking salon income, expenses, and tips.
All data is stored privately on your wife's phone — nothing goes to the internet.

---

## Files in This Package
```
salon-books/
  index.html      ← The main app page
  styles.css      ← All visual styling
  app.js          ← All app logic
  manifest.json   ← Makes it installable as an app
  sw.js           ← Enables offline use
  icon-192.png    ← App icon (small)
  icon-512.png    ← App icon (large)
```

---

## How to Deploy to GitHub Pages (Free Hosting)

### Step 1 — Create a GitHub Account
1. Go to **github.com**
2. Click "Sign up" and create a free account
3. Verify your email

### Step 2 — Create a New Repository
1. After signing in, click the **+** icon (top right) → "New repository"
2. Name it: `salon-books`
3. Set it to **Public** (required for free GitHub Pages)
4. Click **"Create repository"**

### Step 3 — Upload the Files
1. On your new repository page, click **"uploading an existing file"**
2. Drag and drop ALL 8 files from this folder into the upload area
3. Scroll down and click **"Commit changes"**

### Step 4 — Enable GitHub Pages
1. In your repository, click **Settings** (top menu)
2. In the left sidebar, click **Pages**
3. Under "Branch", select **main** from the dropdown
4. Click **Save**
5. Wait 1-2 minutes, then your app will be live at:
   `https://YOUR-USERNAME.github.io/salon-books`

---

## Installing on Her Phone

### Android (Chrome)
1. Open Chrome on her phone
2. Go to your GitHub Pages URL
3. Tap the **⋮ menu** (three dots, top right)
4. Tap **"Add to Home screen"**
5. Tap **"Add"** to confirm
6. Done! She'll see a Salon Books icon on her home screen

### iPhone (Safari)
1. Open **Safari** (must be Safari, not Chrome)
2. Go to your GitHub Pages URL
3. Tap the **Share** button (box with arrow pointing up)
4. Scroll down and tap **"Add to Home Screen"**
5. Tap **"Add"**
6. Done!

---

## How the App Works

### Daily Tab
- Tap **+ Add Income** to log a service (category, amount, payment method, tip)
- Tap **+ Add Expense** for daily costs like supplies
- Use **< >** arrows to navigate between days
- Tap **Edit** to log clients seen and hours worked that day

### Monthly Tab
- Log fixed recurring costs like rent, utilities, insurance
- Navigate between months with the arrows

### Reports Tab
- **Daily** — detailed view of any single day
- **Weekly** — Mon–Sun summary with daily breakdown
- **Monthly** — full month including fixed expenses
- **Annual** — whole year by month
- **Year vs Year** — side-by-side comparison
- **By Category** — where money is coming in and going out
- **Export CSV** — download for Excel or Google Sheets

### Settings Tab
- Set your business name
- Add/remove income and expense categories
- Set up a 4-digit PIN lock

---

## Making Changes Later

To update the app in the future:
1. Download the file you want to change from GitHub
2. Edit it (I'll help you with any changes)
3. Upload the updated file back to GitHub
4. Changes go live in about 1-2 minutes

---

## Need Help?
This app was built with HTML, CSS, and JavaScript.
Bring any questions or desired changes to Claude and we'll update it together!
