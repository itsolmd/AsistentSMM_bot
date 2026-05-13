
echo "Adding all files..."
git add . || { echo "git add failed"; exit 1; }
echo "Committing changes..."
git commit -m "am rezolvat cu mesaje adica structura in mesage main 999 si premier" || { echo "git commit failed"; exit 1; }

echo "Setting branch to main..."
git branch -M main || { echo "git branch failed"; exit 1; }

echo "Pushing to origin main..."
git push -u origin main || { echo "git push failed"; exit 1; }

echo "Done!"



