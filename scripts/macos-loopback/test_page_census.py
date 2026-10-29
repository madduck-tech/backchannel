"""P6b: the page opens no input except by an exact device id (#291).

The one unconstrained `getUserMedia` call is P6a's red variant, and it must sit inside the
`if (test.unconstrained)` block. Any other call without `deviceId: { exact: ... }` would open the
OS default input, which on this Mac is the soundcore headset, and that switches it to HFP.
"""
import os
import re
import unittest

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.js")


def unguarded_calls(source):
    """getUserMedia calls that are neither exact-id nor inside the test.unconstrained block."""
    guard = re.search(r"if \(test\.unconstrained\) \{(.*?)\n  \}", source, re.S)
    allowed = guard.span(1) if guard else (0, 0)
    bad = []
    for m in re.finditer(r"getUserMedia\(", source):
        depth, i = 1, m.end()
        while depth and i < len(source):
            depth += {"(": 1, ")": -1}.get(source[i], 0)
            i += 1
        args = source[m.end():i - 1]
        if re.search(r"deviceId:\s*\{\s*exact:", args):
            continue
        if allowed[0] <= m.start() < allowed[1]:
            continue
        bad.append(source[:m.start()].count("\n") + 1)
    return bad


class ThePageOpensNoDefaultInput(unittest.TestCase):

    def setUp(self):
        with open(PAGE) as f:
            self.source = f.read()

    def test_every_capture_names_its_device_exactly(self):
        self.assertEqual(unguarded_calls(self.source), [])
        self.assertGreaterEqual(self.source.count("getUserMedia("), 2, "the census found the calls it judges")

    def test_p6b_an_unconstrained_call_outside_the_test_block_is_found(self):
        mutated = self.source.replace("  const devices = (await navigator.mediaDevices.enumerateDevices())",
                                      "  await navigator.mediaDevices.getUserMedia({ audio: true });\n"
                                      "  const devices = (await navigator.mediaDevices.enumerateDevices())", 1)
        self.assertNotEqual(mutated, self.source, "the mutation anchor is in page.js")
        self.assertEqual(len(unguarded_calls(mutated)), 1)


if __name__ == "__main__":
    unittest.main()
