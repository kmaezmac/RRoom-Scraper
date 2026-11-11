import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mirror', Path(__file__).parents[1] / 'scripts/configure-ubuntu-mirror.py')
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)

class MirrorTests(unittest.TestCase):
    def test_deb822_preserves_signature_and_suites(self):
        source = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-backports noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
        result = mirror.rewrite(source)
        self.assertEqual(result, source.replace('mirror+file:/etc/apt/apt-mirrors.txt', mirror.ARCHIVE))
        self.assertEqual(mirror.rewrite(result), result)

    def test_direct_azure_and_security_lists(self):
        for scheme in ['http', 'https']:
            for slash in ['', '/']:
                self.assertEqual(mirror.rewrite(f'deb {scheme}://azure.archive.ubuntu.com/ubuntu{slash} noble main'), f'deb {mirror.ARCHIVE} noble main')
        self.assertEqual(mirror.rewrite('URIs: mirror+file:/etc/apt/apt-security-mirrors.txt\n'), f'URIs: {mirror.SECURITY}\n')

    def test_third_party_and_similar_urls_unchanged(self):
        source = 'deb https://packages.microsoft.com/repos/azure-cli/ noble main\ndeb https://azure.archive.ubuntu.com/ubuntu-other noble main\n'
        self.assertEqual(mirror.rewrite(source), source)

    def test_configuration_changes_only_sources_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / 'etc/apt/sources.list.d'
            sources.mkdir(parents=True)
            (root / 'etc/os-release').write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
            file = sources / 'ubuntu.sources'
            file.write_text('URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSigned-By: /key\n')
            with patch.object(mirror.platform, 'machine', return_value='x86_64'):
                mirror.configure(root)
                mirror.configure(root)
            self.assertEqual(file.read_text(), f'URIs: {mirror.ARCHIVE}\nSigned-By: /key\n')

if __name__ == '__main__':
    unittest.main()
