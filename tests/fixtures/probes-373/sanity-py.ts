export const fixture = {
  name: "sanity-py",
  files: {
    "b.py": "def double(x):\n    return x * 2\n\n\ndef triple(x):\n    return x * 3\n\n\nclass Store:\n    def save(self):\n        return double(1)\n",
    "a.py": "from b import double, Store\n\n\ndef run(x):\n    return double(x)\n\n\ndef keep(s: Store):\n    s.save()\n",
  },
  arrows: [
    ["plain call", "a.py#run", "b.py#double", "calls"],
    ["receiver call", "a.py#keep", "b.py#save", "calls"],
    ["PLANTED WRONG", "a.py#run", "b.py#triple", "calls"],
  ],
};
