from ripper.sources import find_better_sources, notice_lines


def test_finds_bandcamp_soundcloud_archive_once_each():
    desc = ("Full album: https://artist.bandcamp.com/album/night-drive (name your price).\n"
            "Also on https://soundcloud.com/artist/night-drive, and https://archive.org/details/night-drive-flac.\n"
            "Again: https://artist.bandcamp.com/album/night-drive")
    found = find_better_sources(desc, links=["https://www.instagram.com/artist", "https://ARTIST.bandcamp.com/"])
    kinds = [f["kind"] for f in found]
    assert kinds == ["bandcamp", "soundcloud", "internet_archive", "bandcamp"]
    assert found[0]["url"] == "https://artist.bandcamp.com/album/night-drive"
    lines = notice_lines(found)
    assert lines[0].startswith("This exists on Bandcamp, which likely offers lossless")
    assert any("Internet Archive" in l for l in lines)


def test_nothing_found_on_a_plain_description():
    assert find_better_sources("Shot on a Fuji. https://example.com/blog") == []
    assert find_better_sources(None) == []
