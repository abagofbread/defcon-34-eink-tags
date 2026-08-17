import os
import gzip
import shutil

def gzip_files(source_folder, destination_folder):
    for root, dirs, files in os.walk(source_folder):
        rel_root = os.path.relpath(root, source_folder)
        if rel_root == '.':
            out_dir = destination_folder
        else:
            out_dir = os.path.join(destination_folder, rel_root)
        os.makedirs(out_dir, exist_ok=True)

        for file in files:
            source_file_path = os.path.join(root, file)
            destination_file_path = os.path.join(out_dir, file + ".gz")
            print(f"Gzipping: {os.path.join(rel_root, file) if rel_root != '.' else file}")
            with open(source_file_path, 'rb') as f_in, gzip.GzipFile(destination_file_path, 'wb', mtime=0) as f_out:
                shutil.copyfileobj(f_in, f_out)

if __name__ == "__main__":
    source_folder = "wwwroot"
    destination_folder = "data/www"
    gzip_files(source_folder, destination_folder)
